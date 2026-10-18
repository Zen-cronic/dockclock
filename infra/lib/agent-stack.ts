import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { CEDAR_POLICIES, GATEWAY_TARGET, SYSTEM_PROMPT, TOOLS } from "@dockclock/agent";
import type { DockClockConfig } from "./config.js";
import type { CoreStack } from "./core-stack.js";
import { CONFIGURATION_SET_NAME } from "./email-stack.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HARNESS_NAME = "dockclock_claims_agent";
const GATEWAY_NAME = "dockclock-tools-gateway";

export interface AgentStackProps extends StackProps {
  config: DockClockConfig;
  core: CoreStack;
}

// The claims agent: an AgentCore Harness (managed agent loop on Bedrock) whose only tools are
// DockClock's, served through an AgentCore Gateway and bounded by Cedar policies. The model reads
// and writes; the tool code and the policies decide.
export class AgentStack extends Stack {
  readonly harnessArn: string;
  readonly invokeFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);
    const { config, core } = props;
    const { region, account } = config;

    const fn = (name: string, entry: string, environment: Record<string, string>, timeout: Duration) =>
      new NodejsFunction(this, name, {
        entry: join(repoRoot, "packages", "agent", "src", entry),
        projectRoot: repoRoot,
        depsLockFilePath: join(repoRoot, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 1024,
        timeout,
        tracing: lambda.Tracing.ACTIVE,
        loggingFormat: lambda.LoggingFormat.JSON,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
        environment: { NODE_OPTIONS: "--enable-source-maps", ...(config.demoFacility ? { DEMO_FACILITY: config.demoFacility } : {}), ...environment },
        bundling: { format: OutputFormat.CJS, minify: true, sourceMap: true, externalModules: [], esbuildArgs: { "--conditions": "source" } },
      });

    const modelArns = [
      `arn:aws:bedrock:${region}:${account}:inference-profile/${config.agentModelId}`,
      `arn:aws:bedrock:*::foundation-model/${config.agentModelId.replace(/^(us|global)\./, "")}`,
    ];

    // The tools the agent can call. Each checks its own preconditions against the sealed pack.
    const tools = fn(
      "Tools",
      "tools.ts",
      {
        TABLE_NAME: core.table.tableName,
        EVIDENCE_BUCKET: core.evidenceBucket.bucketName,
        MEDIA_BUCKET: core.mediaBucket.bucketName,
        BOL_MODEL_ID: config.agentModelId,
        CLAIMS_FROM_EMAIL: config.claimsFromEmail,
        COUNTERPARTY_EMAIL_BROKER: config.counterpartyEmailBroker,
        COUNTERPARTY_EMAIL_SHIPPER: config.counterpartyEmailShipper,
        SES_CONFIGURATION_SET: CONFIGURATION_SET_NAME,
      },
      Duration.seconds(60),
    );
    core.table.grantReadWriteData(tools);
    core.evidenceBucket.grantRead(tools);
    core.mediaBucket.grantRead(tools);
    tools.addToRolePolicy(new iam.PolicyStatement({ actions: ["bedrock:InvokeModel"], resources: modelArns }));
    tools.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendEmail", "ses:SendRawEmail"],
        resources: [`arn:aws:ses:${region}:${account}:identity/*`, `arn:aws:ses:${region}:${account}:configuration-set/${CONFIGURATION_SET_NAME}`],
      }),
    );

    const agentCorePrincipal = (sourceArns: string[]) =>
      new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": account }, ArnLike: { "aws:SourceArn": sourceArns } },
      });

    // Cedar policy engine: default deny, so the agent can call only what a permit names.
    const policyEngine = new agentcore.CfnPolicyEngine(this, "ClaimsPolicies", {
      name: "dockclock_claims_policies",
      description: "Bounds the DockClock claims agent: read tools always, the claim tool only with an approval and an amount under the cap.",
    });

    const gatewayRole = new iam.Role(this, "GatewayRole", { assumedBy: agentCorePrincipal([`arn:aws:bedrock-agentcore:${region}:${account}:gateway/*`]) });
    tools.grantInvoke(gatewayRole);
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:GetPolicyEngine", "bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"],
        // The gateway's own ARN is not known to its role (it would be circular), so scope by name prefix.
        resources: [policyEngine.attrPolicyEngineArn, `${policyEngine.attrPolicyEngineArn}/*`, `arn:aws:bedrock-agentcore:${region}:${account}:gateway/${GATEWAY_NAME}-*`],
      }),
    );

    const gateway = new agentcore.CfnGateway(this, "ToolsGateway", {
      name: GATEWAY_NAME,
      description: "DockClock claims tools as MCP, with every call authorized by Cedar.",
      protocolType: "MCP",
      authorizerType: "AWS_IAM",
      roleArn: gatewayRole.roleArn,
      policyEngineConfiguration: { arn: policyEngine.attrPolicyEngineArn, mode: "ENFORCE" },
      exceptionLevel: "DEBUG",
    });
    // An L1 resource that names a role waits only for the role, not its policy; wait for both.
    gateway.node.addDependency(gatewayRole);

    const target = new agentcore.CfnGatewayTarget(this, "ToolsTarget", {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      name: GATEWAY_TARGET,
      description: "DockClock claims tools (Lambda).",
      targetConfiguration: { mcp: { lambda: { lambdaArn: tools.functionArn, toolSchema: { inlinePayload: TOOLS } } } },
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
    });

    for (const [name, statement] of Object.entries(CEDAR_POLICIES)) {
      const policy = new agentcore.CfnPolicy(this, `Policy-${name}`, {
        name,
        policyEngineId: policyEngine.attrPolicyEngineId,
        definition: { cedar: { statement: statement.replaceAll("resource);", `resource == AgentCore::Gateway::"${gateway.attrGatewayArn}");`).replace("resource) when", `resource == AgentCore::Gateway::"${gateway.attrGatewayArn}") when`) } },
      });
      policy.addDependency(target);
    }

    // The harness: a managed agent loop on Bedrock whose tools are the gateway's.
    const harnessRole = new iam.Role(this, "HarnessRole", { assumedBy: agentCorePrincipal([
        // A harness runs on an AgentCore Runtime, which assumes the role under its own ARN.
        `arn:aws:bedrock-agentcore:${region}:${account}:harness/*`,
        `arn:aws:bedrock-agentcore:${region}:${account}:runtime/*`,
      ]) });
    harnessRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], resources: modelArns }));
    harnessRole.addToPolicy(new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeGateway"], resources: [gateway.attrGatewayArn] }));
    harnessRole.addToPolicy(new iam.PolicyStatement({ actions: ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"], resources: ["*"] }));
    harnessRole.addToPolicy(new iam.PolicyStatement({ actions: ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"], resources: ["*"] }));
    harnessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup", "logs:DescribeLogStreams", "logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [`arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`, `arn:aws:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`],
      }),
    );
    harnessRole.addToPolicy(new iam.PolicyStatement({ actions: ["logs:DescribeLogGroups"], resources: [`arn:aws:logs:${region}:${account}:log-group:*`] }));
    harnessRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["cloudwatch:PutMetricData"], resources: ["*"], conditions: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } } }),
    );
    harnessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"],
        resources: [
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${region}:${account}:workload-identity-directory/default/workload-identity/harness_${HARNESS_NAME}-*`,
        ],
      }),
    );

    const harness = new agentcore.CfnHarness(this, "ClaimsAgent", {
      harnessName: HARNESS_NAME,
      executionRoleArn: harnessRole.roleArn,
      model: { bedrockModelConfig: { modelId: config.agentModelId, maxTokens: 2048, temperature: 0.2 } },
      systemPrompt: [{ text: SYSTEM_PROMPT }],
      tools: [{ type: "agentcore_gateway", name: "dockclock", config: { agentCoreGateway: { gatewayArn: gateway.attrGatewayArn } } }],
      memory: { disabled: {} },
      maxIterations: 12,
      maxTokens: 16000,
      timeoutSeconds: 240,
    });
    harness.node.addDependency(harnessRole);
    this.harnessArn = harness.attrArn;

    // How the workflow and scripts start the agent: a fixed task line and a validated load id.
    this.invokeFunction = fn("InvokeAgent", "invoke.ts", { HARNESS_ARN: harness.attrArn }, Duration.minutes(5));
    this.invokeFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"], resources: [harness.attrArn, `${harness.attrArn}/*`] }),
    );

    new CfnOutput(this, "HarnessArn", { value: harness.attrArn });
    new CfnOutput(this, "GatewayArn", { value: gateway.attrGatewayArn });
    new CfnOutput(this, "PolicyEngineArn", { value: policyEngine.attrPolicyEngineArn });
    new CfnOutput(this, "InvokeAgentFunction", { value: this.invokeFunction.functionName });
    new CfnOutput(this, "ToolsFunction", { value: tools.functionName });
  }
}
