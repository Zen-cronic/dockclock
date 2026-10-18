import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import { SqsSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";
import type { DockClockConfig } from "./config.js";
import type { CoreStack } from "./core-stack.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_MACHINE_NAME = "dockclock-load-lifecycle";

export interface MessagingStackProps extends StackProps {
  config: DockClockConfig;
  core: CoreStack;
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
        environment: { TABLE_NAME: core.table.tableName, NODE_OPTIONS: "--enable-source-maps", ...environment },
        // Bundle workspace packages from source so a deploy can never ship a stale compiled dist/.
        bundling: { format: OutputFormat.CJS, minify: true, sourceMap: true, externalModules: [], esbuildArgs: { "--conditions": "source" } },
      });

    const channelEnv = {
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
    };
    const phoneArn = `arn:aws:social-messaging:${config.region}:${config.account}:phone-number-id/${config.originationPhoneId.replace(/^phone-number-id-/, "")}`;
    const sendWhatsApp = new iam.PolicyStatement({ actions: ["social-messaging:SendWhatsAppMessage"], resources: [phoneArn] });
    const taskResponse = new iam.PolicyStatement({ actions: ["states:SendTaskSuccess", "states:SendTaskFailure"], resources: [stateMachineArn] });

    const ingest = fn("Ingest", "ingest.ts", channelEnv);
    core.table.grantReadWriteData(ingest);
    core.identitySecret.grantRead(ingest);
    ingest.addToRolePolicy(taskResponse);
    ingest.addToRolePolicy(sendWhatsApp);
    ingest.addToRolePolicy(new iam.PolicyStatement({ actions: ["social-messaging:GetWhatsAppMessageMedia"], resources: [phoneArn] }));
    core.mediaBucket.grantReadWrite(ingest);

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
    dispatch.addToRolePolicy(new iam.PolicyStatement({ actions: ["states:StartExecution"], resources: [stateMachineArn] }));

    // Lifecycle: wait for the Arrived pin, the Released pin and the bill-of-lading Flow, then seal.
    const waitFor = (step: "arrived" | "released" | "bol", timeout: Duration) =>
      new tasks.LambdaInvoke(this, `Await ${step}`, {
        lambdaFunction: awaitStep,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({ loadId: sfn.JsonPath.stringAt("$.loadId"), step, token: sfn.JsonPath.taskToken }),
        resultPath: `$.${step}`,
        taskTimeout: sfn.Timeout.duration(timeout),
      });
    const markTimedOut = new tasks.DynamoUpdateItem(this, "Mark timed out", {
      table: core.table,
      key: {
        pk: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.format("LOAD#{}", sfn.JsonPath.stringAt("$.loadId"))),
        sk: tasks.DynamoAttributeValue.fromString("META"),
      },
      updateExpression: "SET outcome = :o",
      expressionAttributeValues: { ":o": tasks.DynamoAttributeValue.fromString("TIMED_OUT_NEEDS_HUMAN") },
      resultPath: sfn.JsonPath.DISCARD,
    }).next(new sfn.Succeed(this, "Handed to a person"));
    const sealPack = new tasks.LambdaInvoke(this, "Seal evidence", {
      lambdaFunction: seal,
      payload: sfn.TaskInput.fromObject({ loadId: sfn.JsonPath.stringAt("$.loadId") }),
      resultSelector: { "pack.$": "$.Payload" },
      resultPath: "$.seal",
    });
    sealPack.next(new sfn.Succeed(this, "Sealed"));
    // Missing paperwork never holds a load open: after six hours the pack is sealed without it,
    // and the clause engine routes the claim to a person.
    const definition = waitFor("arrived", Duration.days(2))
      .addCatch(markTimedOut, { errors: ["States.Timeout"], resultPath: "$.error" })
      .next(waitFor("released", Duration.days(3)).addCatch(markTimedOut, { errors: ["States.Timeout"], resultPath: "$.error" }))
      .next(waitFor("bol", Duration.hours(6)).addCatch(sealPack, { errors: ["States.Timeout"], resultPath: "$.bolTimeout" }))
      .next(sealPack);

    const lifecycle = new sfn.StateMachine(this, "LoadLifecycle", {
      stateMachineName: STATE_MACHINE_NAME,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.days(7),
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
    ingest.addEventSource(new SqsEventSource(queue, { batchSize: 10, reportBatchItemFailures: true }));

    new cloudwatch.Alarm(this, "IngestDeadLettersAlarm", {
      alarmDescription: "A WhatsApp event failed ingest five times and is parked in the dead-letter queue.",
      metric: deadLetters.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, "StateMachineArn", { value: lifecycle.stateMachineArn });
    new CfnOutput(this, "DispatchFunction", { value: dispatch.functionName });
    new CfnOutput(this, "IngestQueueUrl", { value: queue.queueUrl });
    new CfnOutput(this, "TableName", { value: core.table.tableName });
    new CfnOutput(this, "EvidenceBucket", { value: core.evidenceBucket.bucketName });
    new CfnOutput(this, "EvidenceKeyArn", { value: core.evidenceKey.keyArn });
    new CfnOutput(this, "IdentitySecretArn", { value: core.identitySecret.secretArn });
  }
}
