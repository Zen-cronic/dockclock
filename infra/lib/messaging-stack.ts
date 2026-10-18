import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import * as sns from "aws-cdk-lib/aws-sns";
import { SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import type { EmailStack } from "./email-stack.js";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";
import type { DockClockConfig } from "./config.js";
import { CONFIGURATION_SET_NAME } from "./email-stack.js";
import type { CoreStack } from "./core-stack.js";
import { INVOKE_AGENT_FUNCTION_NAME, TOOLS_FUNCTION_NAME } from "./agent-stack.js";
import { RCS_MEDIA_PREFIX, RcsChannel } from "./rcs.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_MACHINE_NAME = "dockclock-load-lifecycle";
const NOTICE_SCHEDULE_GROUP = "dockclock-notices";

export interface MessagingStackProps extends StackProps {
  config: DockClockConfig;
  core: CoreStack;
  email: EmailStack;
}

// The driver loop: WhatsApp events arrive on the existing End User Messaging topic, land in an
// ingest queue, and drive one Step Functions execution per load until its evidence is sealed.
export class MessagingStack extends Stack {
  constructor(scope: Construct, id: string, props: MessagingStackProps) {
    super(scope, id, props);
    const { config, core } = props;
    // Built from the name so Lambda policies can reference it without a dependency cycle.
    const stateMachineArn = `arn:aws:states:${config.region}:${config.account}:stateMachine:${STATE_MACHINE_NAME}`;

    const fn = (name: string, entry: string, environment: Record<string, string>, timeout = Duration.seconds(30)) =>
      new NodejsFunction(this, name, {
        entry: join(repoRoot, "services", "src", entry),
        projectRoot: repoRoot,
        depsLockFilePath: join(repoRoot, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout,
        tracing: lambda.Tracing.ACTIVE,
        loggingFormat: lambda.LoggingFormat.JSON,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
        environment: {
          TABLE_NAME: core.table.tableName,
          NODE_OPTIONS: "--enable-source-maps",
          ...(config.demoFacility ? { DEMO_FACILITY: config.demoFacility } : {}),
          ...environment,
        },
        // Bundle workspace packages from source so a deploy can never ship a stale compiled dist/.
        bundling: { format: OutputFormat.CJS, minify: true, sourceMap: true, externalModules: [], esbuildArgs: { "--conditions": "source" } },
      });

    const rcs = config.rcsAgentId
      ? new RcsChannel(this, "Rcs", { account: config.account, region: config.region, agentId: config.rcsAgentId, mediaBucket: core.mediaBucket })
      : null;
    const channelEnv = {
      ...rcs?.environment,
      ACCOUNT_ID: config.account,
      TOPIC_ARN: config.whatsappEventsTopicArn,
      META_WABA_ID: config.metaWabaId,
      META_PHONE_ID: config.metaPhoneId,
      ORIGINATION_PHONE_ID: config.originationPhoneId,
      META_API_VERSION: config.metaApiVersion,
      IDENTITY_SECRET_ARN: core.identitySecret.secretArn,
      DRIVER_REPLIES: config.driverReplies,
      DRIVER_ALLOWLIST: config.driverAllowlist,
      MEDIA_BUCKET: core.mediaBucket.bucketName,
      RELEASE_FLOW_ID: config.releaseFlowId,
      FLOW_MODE: config.flowMode,
      DISPATCH_EMAIL: config.dispatchEmail,
      DISPATCHER_PHONE: config.dispatcherPhone,
      FROM_EMAIL: config.fromEmail,
      SES_CONFIGURATION_SET: CONFIGURATION_SET_NAME,
    };
    const phoneArn = `arn:aws:social-messaging:${config.region}:${config.account}:phone-number-id/${config.originationPhoneId.replace(/^phone-number-id-/, "")}`;
    const sendWhatsApp = new iam.PolicyStatement({ actions: ["social-messaging:SendWhatsAppMessage"], resources: [phoneArn] });
    const taskResponse = new iam.PolicyStatement({ actions: ["states:SendTaskSuccess", "states:SendTaskFailure"], resources: [stateMachineArn] });

    const ingest = fn("Ingest", "ingest.ts", channelEnv);
    core.table.grantReadWriteData(ingest);
    core.identitySecret.grantRead(ingest);
    ingest.addToRolePolicy(taskResponse);
    ingest.addToRolePolicy(sendWhatsApp);
    if (rcs) ingest.addToRolePolicy(rcs.sendRcs);
    ingest.addToRolePolicy(new iam.PolicyStatement({ actions: ["social-messaging:GetWhatsAppMessageMedia"], resources: [phoneArn] }));
    core.mediaBucket.grantReadWrite(ingest);
    // identity/* rather than the sender alone: in the SES sandbox the recipient identities are
    // authorized too.
    const sesSend = new iam.PolicyStatement({
      actions: ["ses:SendEmail"],
      resources: [`arn:aws:ses:${config.region}:${config.account}:identity/*`, `arn:aws:ses:${config.region}:${config.account}:configuration-set/${CONFIGURATION_SET_NAME}`],
    });
    ingest.addToRolePolicy(sesSend);

    const awaitStep = fn("AwaitStep", "await-step.ts", {});
    core.table.grantReadWriteData(awaitStep);
    awaitStep.addToRolePolicy(taskResponse);

    const seal = fn("Seal", "seal.ts", {
      EVIDENCE_BUCKET: core.evidenceBucket.bucketName,
      EVIDENCE_KEY_ARN: core.evidenceKey.keyArn,
      MEDIA_BUCKET: core.mediaBucket.bucketName,
    });
    core.table.grantReadWriteData(seal);
    core.evidenceBucket.grantPut(seal);
    seal.addToRolePolicy(new iam.PolicyStatement({ actions: ["s3:PutObjectRetention"], resources: [core.evidenceBucket.arnForObjects("packs/*")] }));
    core.evidenceKey.grant(seal, "kms:Sign", "kms:GetPublicKey");
    core.mediaBucket.grantRead(seal);

    const dispatch = fn("Dispatch", "dispatch.ts", { ...channelEnv, STATE_MACHINE_ARN: stateMachineArn });
    core.table.grantReadWriteData(dispatch);
    core.identitySecret.grantRead(dispatch);
    dispatch.addToRolePolicy(sendWhatsApp);
    if (rcs) dispatch.addToRolePolicy(rcs.sendRcs);
    dispatch.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:StartExecution"], resources: [stateMachineArn] }));

    // Lifecycle: wait for the Arrived pin, the Released pin and the bill-of-lading Flow, then seal.
    const waitFor = (step: "arrived" | "released" | "bol" | "retake", timeout: sfn.Timeout) =>
      new tasks.LambdaInvoke(this, `Await ${step}`, {
        lambdaFunction: awaitStep,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({ loadId: sfn.JsonPath.stringAt("$.loadId"), step, token: sfn.JsonPath.taskToken }),
        resultPath: `$.${step}`,
        taskTimeout: timeout,
      });
    // Ending a load writes a terminal phase into it, so the driver loop refuses later input.
    const closeLoad = (id: string, outcome: string) =>
      new tasks.DynamoUpdateItem(this, id, {
        table: core.table,
        key: {
          pk: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.format("LOAD#{}", sfn.JsonPath.stringAt("$.loadId"))),
          sk: tasks.DynamoAttributeValue.fromString("META"),
        },
        updateExpression: "SET phase = :c, outcome = :o",
        conditionExpression: "phase <> :s",
        expressionAttributeValues: {
          ":c": tasks.DynamoAttributeValue.fromString("closed"),
          ":o": tasks.DynamoAttributeValue.fromString(outcome),
          ":s": tasks.DynamoAttributeValue.fromString("sealed"),
        },
        resultPath: sfn.JsonPath.DISCARD,
      });
    const markTimedOut = closeLoad("Mark timed out", "TIMED_OUT_NEEDS_HUMAN").next(new sfn.Succeed(this, "Handed to a person"));
    const markSealFailed = closeLoad("Mark seal failed", "SEAL_FAILED").next(new sfn.Fail(this, "Seal failed", { error: "SealFailed", cause: "Seal evidence failed after retries" }));
    const sealPack = new tasks.LambdaInvoke(this, "Seal evidence", {
      lambdaFunction: seal,
      payload: sfn.TaskInput.fromObject({ loadId: sfn.JsonPath.stringAt("$.loadId") }),
      resultSelector: { "pack.$": "$.Payload" },
      resultPath: "$.seal",
    });
    sealPack.addRetry({ errors: ["States.TaskFailed"], interval: Duration.seconds(10), maxAttempts: 3, backoffRate: 2 });
    sealPack.addCatch(markSealFailed, { errors: ["States.ALL"], resultPath: "$.sealError" });

    // Before sealing, the agent's bill-of-lading tool reads the photo once, so the reading is part
    // of the signed evidence. It never blocks: an unreadable or missing photo just seals without it.
    const agentTools = lambda.Function.fromFunctionName(this, "AgentTools", TOOLS_FUNCTION_NAME);
    const invokeAgent = lambda.Function.fromFunctionName(this, "InvokeAgent", INVOKE_AGENT_FUNCTION_NAME);
    const readBol = new tasks.LambdaInvoke(this, "Read bill of lading", {
      lambdaFunction: agentTools,
      clientContext: Buffer.from(JSON.stringify({ custom: { bedrockAgentCoreToolName: "dockclock-tools___read_bill_of_lading" } })).toString("base64"),
      payload: sfn.TaskInput.fromObject({ loadId: sfn.JsonPath.stringAt("$.loadId") }),
      // The whole tool result: on a missing photo it is an error object with no reading.
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.bolReading",
      taskTimeout: sfn.Timeout.duration(Duration.seconds(90)),
    });
    readBol.addCatch(sealPack, { errors: ["States.ALL"], resultPath: "$.bolReadError" });

    // Detention notice: one EventBridge Scheduler job per load, created after the Arrived pin and
    // fired before free time ends. SES delivery events then mark the notice delivered.
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, "NoticeSchedules", { name: NOTICE_SCHEDULE_GROUP });
    const schedulerRole = new iam.Role(this, "NoticeSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": config.account } } }),
    });
    const noticeFn = fn("Notice", "notice.ts", {
      ...channelEnv,
      CLAIMS_FROM_EMAIL: config.claimsFromEmail,
      COUNTERPARTY_EMAIL_BROKER: config.counterpartyEmailBroker,
      COUNTERPARTY_EMAIL_SHIPPER: config.counterpartyEmailShipper,
      NOTICE_SCHEDULE_GROUP: NOTICE_SCHEDULE_GROUP,
      NOTICE_SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
    });
    noticeFn.grantInvoke(schedulerRole);
    core.table.grantReadWriteData(noticeFn);
    core.identitySecret.grantRead(noticeFn);
    noticeFn.addToRolePolicy(sendWhatsApp);
    if (rcs) noticeFn.addToRolePolicy(rcs.sendRcs);
    noticeFn.addToRolePolicy(sesSend);
    noticeFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["scheduler:CreateSchedule"], resources: [`arn:aws:scheduler:${config.region}:${config.account}:schedule/${NOTICE_SCHEDULE_GROUP}/*`] }),
    );
    noticeFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["iam:PassRole"], resources: [schedulerRole.roleArn] }));
    noticeFn.node.addDependency(scheduleGroup);
    props.email.emailEvents.addSubscription(new LambdaSubscription(noticeFn));
    const scheduleNotice = new tasks.LambdaInvoke(this, "Schedule detention notice", {
      lambdaFunction: noticeFn,
      payload: sfn.TaskInput.fromObject({ kind: "schedule", loadId: sfn.JsonPath.stringAt("$.loadId") }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Photo retake: asked once, when the reading says the photo cannot be read.
    const retakeFn = fn("RequestRetake", "retake.ts", channelEnv);
    core.table.grantReadWriteData(retakeFn);
    core.identitySecret.grantRead(retakeFn);
    core.mediaBucket.grantReadWrite(retakeFn);
    retakeFn.addToRolePolicy(sendWhatsApp);
    retakeFn.addToRolePolicy(new iam.PolicyStatement({ actions: ["social-messaging:GetWhatsAppMessageMedia"], resources: [phoneArn] }));
    if (rcs) retakeFn.addToRolePolicy(rcs.sendRcs);
    retakeFn.addToRolePolicy(sesSend);
    const requestRetake = new tasks.LambdaInvoke(this, "Ask for a clearer photo", {
      lambdaFunction: retakeFn,
      payload: sfn.TaskInput.fromObject({ loadId: sfn.JsonPath.stringAt("$.loadId") }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.retakeRequest",
    });
    const readRetaken = new tasks.LambdaInvoke(this, "Read the retaken photo", {
      lambdaFunction: agentTools,
      clientContext: Buffer.from(JSON.stringify({ custom: { bedrockAgentCoreToolName: "dockclock-tools___read_bill_of_lading" } })).toString("base64"),
      payload: sfn.TaskInput.fromObject({ loadId: sfn.JsonPath.stringAt("$.loadId") }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.bolReading",
      taskTimeout: sfn.Timeout.duration(Duration.seconds(90)),
    });
    readRetaken.addCatch(sealPack, { errors: ["States.ALL"], resultPath: "$.bolReadError" });
    readRetaken.next(sealPack);
    const awaitRetake = waitFor("retake", sfn.Timeout.duration(Duration.hours(1)));
    awaitRetake.addCatch(sealPack, { errors: ["States.ALL"], resultPath: "$.retakeTimeout" });
    awaitRetake.next(readRetaken);
    requestRetake.addCatch(sealPack, { errors: ["States.ALL"], resultPath: "$.retakeError" });
    requestRetake.next(
      new sfn.Choice(this, "Retake requested?")
        .when(sfn.Condition.booleanEquals("$.retakeRequest.result.requested", true), awaitRetake)
        .otherwise(sealPack),
    );

    readBol.next(
      new sfn.Choice(this, "Photo readable?")
        .when(sfn.Condition.and(sfn.Condition.isPresent("$.bolReading.result.legible"), sfn.Condition.booleanEquals("$.bolReading.result.legible", false)), requestRetake)
        .otherwise(sealPack),
    );

    const notifyFn = fn("NotifyDispatch", "notify.ts", channelEnv);
    core.table.grantReadData(notifyFn);
    notifyFn.addToRolePolicy(sesSend);
    const notify = (id: string, reason: string) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: notifyFn,
        payload: sfn.TaskInput.fromObject({ loadId: sfn.JsonPath.stringAt("$.loadId"), reason }),
        resultPath: sfn.JsonPath.DISCARD,
      });

    const requestApprovalFn = fn("RequestApproval", "request-approval.ts", channelEnv);
    core.table.grantReadWriteData(requestApprovalFn);
    core.identitySecret.grantRead(requestApprovalFn);
    requestApprovalFn.addToRolePolicy(sendWhatsApp);
    // The dispatcher's Approve tap (handled by ingest) returns this task; Hold fails it.
    const requestApproval = new tasks.LambdaInvoke(this, "Ask dispatch to approve", {
      lambdaFunction: requestApprovalFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({ loadId: sfn.JsonPath.stringAt("$.loadId"), amountUsd: sfn.JsonPath.numberAt("$.seal.pack.amountUsd"), token: sfn.JsonPath.taskToken }),
      resultPath: "$.approval",
      taskTimeout: sfn.Timeout.duration(Duration.days(2)),
    });
    const fileClaim = new tasks.LambdaInvoke(this, "Agent files the claim", {
      lambdaFunction: invokeAgent,
      payload: sfn.TaskInput.fromObject({ loadId: sfn.JsonPath.stringAt("$.loadId"), task: "file_claim" }),
      resultSelector: { "result.$": "$.Payload" },
      resultPath: "$.agent",
    });
    // Trust, then verify: the workflow reads the claim record itself rather than the agent's words.
    const checkClaim = new tasks.DynamoGetItem(this, "Check claim record", {
      table: core.table,
      key: {
        pk: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.format("LOAD#{}", sfn.JsonPath.stringAt("$.loadId"))),
        sk: tasks.DynamoAttributeValue.fromString("CLAIM"),
      },
      consistentRead: true,
      resultPath: "$.claim",
    });
    const handedOver = new sfn.Succeed(this, "Claim handed to a person");
    const notFiled = notify("Tell dispatch the claim was not filed", "approved, but the claims agent did not file the claim; send it by hand").next(handedOver);
    fileClaim.addCatch(notFiled, { errors: ["States.ALL"], resultPath: "$.agentError" });
    checkClaim.addCatch(notFiled, { errors: ["States.ALL"], resultPath: "$.claimError" });
    requestApproval.addCatch(new sfn.Succeed(this, "Held by dispatch"), { errors: ["HeldByDispatch"], resultPath: "$.held" });
    requestApproval.addCatch(notify("Tell dispatch approval timed out", "no approval within two days; nothing was sent").next(new sfn.Succeed(this, "Approval timed out")), {
      errors: ["States.ALL"],
      resultPath: "$.approvalError",
    });
    requestApproval.next(fileClaim).next(checkClaim).next(
      new sfn.Choice(this, "Claim sent?")
        // A selector on a missing field fails uncatchably, so presence is checked in the condition.
        .when(sfn.Condition.and(sfn.Condition.isPresent("$.claim.Item.status.S"), sfn.Condition.stringEquals("$.claim.Item.status.S", "sent")), new sfn.Succeed(this, "Claim filed"))
        .otherwise(notFiled),
    );
    sealPack.next(
      new sfn.Choice(this, "Verdict?")
        .when(sfn.Condition.stringEquals("$.seal.pack.verdict", "BILLABLE"), requestApproval)
        .when(sfn.Condition.stringEquals("$.seal.pack.verdict", "NEEDS_HUMAN"), notify("Tell dispatch it needs a person", "sealed as NEEDS_HUMAN; review the pack before any claim").next(new sfn.Succeed(this, "Needs a person")))
        .otherwise(new sfn.Succeed(this, "Not billable")),
    );
    // Missing paperwork never holds a load open: after six hours the pack is sealed without it,
    // and the clause engine routes the claim to a person.
    // The arrival wait is measured from the appointment (dispatch passes the seconds), so a load
    // booked days ahead is not handed to a person before the driver could arrive.
    // The notice is scheduled right after arrival and never blocks the load if scheduling fails.
    const awaitReleased = waitFor("released", sfn.Timeout.duration(Duration.days(3))).addCatch(markTimedOut, { errors: ["States.Timeout"], resultPath: "$.error" });
    scheduleNotice.addCatch(awaitReleased, { errors: ["States.ALL"], resultPath: "$.noticeError" });
    const definition = waitFor("arrived", sfn.Timeout.at("$.arrivalTimeoutSeconds"))
      .addCatch(markTimedOut, { errors: ["States.Timeout"], resultPath: "$.error" })
      .next(scheduleNotice)
      .next(awaitReleased)
      .next(waitFor("bol", sfn.Timeout.duration(Duration.hours(6))).addCatch(sealPack, { errors: ["States.Timeout"], resultPath: "$.bolTimeout" }))
      .next(readBol);

    const lifecycle = new sfn.StateMachine(this, "LoadLifecycle", {
      stateMachineName: STATE_MACHINE_NAME,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.days(10),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, "LifecycleLogs", { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
        level: sfn.LogLevel.ERROR,
      },
    });

    // Ingest queue on the existing WhatsApp events topic. The topic is standard (not FIFO), so
    // ordering and duplicates are handled by the per-load transaction in the ingest handler.
    const deadLetters = new sqs.Queue(this, "IngestDeadLetters", { retentionPeriod: Duration.days(14), enforceSSL: true });
    const queue = new sqs.Queue(this, "IngestQueue", {
      visibilityTimeout: Duration.seconds(180),
      enforceSSL: true,
      deadLetterQueue: { queue: deadLetters, maxReceiveCount: 5 },
    });
    sns.Topic.fromTopicArn(this, "WhatsAppEvents", config.whatsappEventsTopicArn).addSubscription(new SqsSubscription(queue));
    rcs?.topic.addSubscription(new SqsSubscription(queue));
    ingest.addEventSource(new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }));

    new cloudwatch.Alarm(this, "IngestDeadLettersAlarm", {
      alarmDescription: "A WhatsApp event failed ingest five times and is parked in the dead-letter queue.",
      metric: deadLetters.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, "LifecycleFailedAlarm", {
      alarmDescription: "A load lifecycle execution failed (for example, sealing failed after retries).",
      metric: lifecycle.metricFailed({ period: Duration.minutes(5) }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, "StateMachineArn", { value: lifecycle.stateMachineArn });
    new CfnOutput(this, "DispatchFunction", { value: dispatch.functionName });
    new CfnOutput(this, "NoticeFunction", { value: noticeFn.functionName });
    new CfnOutput(this, "IngestQueueUrl", { value: queue.queueUrl });
    new CfnOutput(this, "TableName", { value: core.table.tableName });
    new CfnOutput(this, "EvidenceBucket", { value: core.evidenceBucket.bucketName });
    new CfnOutput(this, "EvidenceKeyArn", { value: core.evidenceKey.keyArn });
    new CfnOutput(this, "IdentitySecretArn", { value: core.identitySecret.secretArn });
    if (rcs) {
      // Inputs for update-rcs-agent (npm run rcs:two-way), which turns two-way on for the agent.
      new CfnOutput(this, "RcsTopicArn", { value: rcs.topic.topicArn });
      new CfnOutput(this, "RcsTwoWayRoleArn", { value: rcs.twoWayRole.roleArn });
      new CfnOutput(this, "RcsMediaRoleArn", { value: rcs.mediaRole.roleArn });
      new CfnOutput(this, "RcsMediaBucket", { value: core.mediaBucket.bucketName });
      new CfnOutput(this, "RcsMediaPrefix", { value: RCS_MEDIA_PREFIX });
    }
  }
}
