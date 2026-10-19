import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildApp } from "../lib/app.js";

const config = {
  account: "111122223333",
  region: "us-east-1",
  whatsappEventsTopicArn: "arn:aws:sns:us-east-1:111122223333:events",
  originationPhoneId: "phone-number-id-abc",
  metaWabaId: "waba-1",
  metaPhoneId: "phone-1",
  metaApiVersion: "v23.0",
  driverReplies: "off" as const,
  driverAllowlist: "",
  releaseFlowId: "1000",
  flowMode: "draft" as const,
  dispatchEmail: "dispatch@example.com",
  dispatcherPhone: "+15555550100",
  fromEmail: "dockclock@example.com",
  demoFacility: "",
  agentModelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  claimsFromEmail: "DockClock Claims <claims@example.com>",
  counterpartyEmailBroker: "broker@example.com",
  counterpartyEmailShipper: "shipper@example.com",
  rcsAgentId: "rcs-0123456789abcdef",
};

describe("stacks", () => {
  const { core, messaging, email, agent } = buildApp(config, new App({ context: { "aws:cdk:bundling-stacks": [] } }));
  const coreT = Template.fromStack(core);
  const msgT = Template.fromStack(messaging);

  it("signs with an asymmetric P-256 key and locks evidence in governance mode", () => {
    coreT.hasResourceProperties("AWS::KMS::Key", { KeySpec: "ECC_NIST_P256", KeyUsage: "SIGN_VERIFY" });
    coreT.hasResourceProperties("AWS::S3::Bucket", {
      ObjectLockEnabled: true,
      ObjectLockConfiguration: { ObjectLockEnabled: "Enabled", Rule: { DefaultRetention: { Mode: "GOVERNANCE", Days: 30 } } },
    });
  });

  it("subscribes a standard queue with a dead-letter queue to the existing topic", () => {
    msgT.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "sqs", TopicArn: config.whatsappEventsTopicArn });
    msgT.hasResourceProperties("AWS::SQS::Queue", { RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }) });
    msgT.hasResourceProperties("AWS::Lambda::EventSourceMapping", { FunctionResponseTypes: ["ReportBatchItemFailures"] });
  });

  it("waits on task tokens for both pins before sealing", () => {
    const machines = msgT.findResources("AWS::StepFunctions::StateMachine");
    const definition = JSON.stringify(Object.values(machines)[0]?.Properties?.DefinitionString);
    expect(definition).toContain("waitForTaskToken");
    // The retake wait comes from the retake request (10 minutes on demo loads, an hour otherwise).
    expect(definition).toContain('\\"TimeoutSecondsPath\\":\\"$.retakeRequest.result.waitSeconds\\"');
    expect(definition).toContain("Await arrived");
    expect(definition).toContain("Await released");
    expect(definition).toContain("Await bol");
    // The arrival timeout comes from the execution input, measured from the appointment.
    expect(definition).toContain('\\"TimeoutSecondsPath\\":\\"$.arrivalTimeoutSeconds\\"');
    expect(definition).toContain("Seal failed");
    expect(definition).toContain("Seal evidence");
  });

  it("routes bounces and complaints to SNS and alarms on reputation", () => {
    const emailT = Template.fromStack(email);
    emailT.hasResourceProperties("AWS::SES::ConfigurationSet", { Name: "dockclock-claims", ReputationOptions: { ReputationMetricsEnabled: true } });
    emailT.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
      EventDestination: Match.objectLike({ Enabled: true, MatchingEventTypes: Match.arrayWith(["bounce", "complaint"]) }),
    });
    emailT.resourceCountIs("AWS::CloudWatch::Alarm", 2);
  });

  it("lets only the seal function sign, and names every function that may message a driver", () => {
    const policies = Object.values(msgT.findResources("AWS::IAM::Policy")).map((p) => JSON.stringify(p));
    expect(policies.filter((p) => p.includes("kms:Sign"))).toHaveLength(1);
    // Ingest replies in-window, dispatch sends the load template, the approval request messages the
    // dispatcher, the notice tells the driver it went out, the retake asks for a clearer photo and
    // the outcome teller reports the verdict and the filed claim.
    expect(policies.filter((p) => p.includes("social-messaging:SendWhatsAppMessage"))).toHaveLength(6);
    expect(policies.filter((p) => p.includes("social-messaging:GetWhatsAppMessageMedia"))).toHaveLength(2);
    // The driver-facing functions may send RCS, and only through the configured agent.
    const rcs = policies.filter((p) => p.includes("sms-voice:SendRcsMessage"));
    expect(rcs).toHaveLength(5);
    for (const p of rcs) expect(p).toContain(`rcs-agent/${config.rcsAgentId}`);
  });

  it("seals, asks dispatch, lets the agent file and then checks the claim record", () => {
    const [definition] = Object.values(msgT.findResources("AWS::StepFunctions::StateMachine")).map((r) => JSON.stringify(r));
    for (const state of ["Schedule detention notice", "Tell the driver the verdict", "Tell the driver the claim was filed", "Photo readable?", "Ask for a clearer photo", "Await retake", "Read the retaken photo", "Read bill of lading", "Seal evidence", "Verdict?", "Ask dispatch to approve", "Agent files the claim", "Check claim record", "Claim sent?", "Held by dispatch"]) {
      expect(definition).toContain(state);
    }
    expect(definition).toContain("waitForTaskToken");
    // The retake wait comes from the retake request (10 minutes on demo loads, an hour otherwise).
    expect(definition).toContain('\\"TimeoutSecondsPath\\":\\"$.retakeRequest.result.waitSeconds\\"');
  });

  it("feeds RCS two-way traffic and delivery events into the same ingest queue", () => {
    msgT.hasResourceProperties("AWS::SNS::Topic", { TopicName: "dockclock-rcs-events" });
    // Two into the ingest queue, plus SES delivery events into the notice function.
    msgT.resourceCountIs("AWS::SNS::Subscription", 3);
    msgT.hasResourceProperties("AWS::SMSVOICE::ConfigurationSet", {
      ConfigurationSetName: "dockclock-rcs",
      EventDestinations: [Match.objectLike({ Enabled: true, MatchingEventTypes: ["RCS_ALL"] })],
    });
    // Both roles are assumable only by End User Messaging, on behalf of this account.
    const trust = Object.values(msgT.findResources("AWS::IAM::Role")).map((r) => JSON.stringify(r.Properties.AssumeRolePolicyDocument));
    expect(trust.filter((t) => t.includes("sms-voice.amazonaws.com") && t.includes(config.account))).toHaveLength(2);
    const media = Object.values(msgT.findResources("AWS::IAM::Policy")).map((p) => JSON.stringify(p)).find((p) => p.includes("rcs-inbound/*"));
    expect(media).toContain("s3:PutObject");
    expect(media).not.toContain("s3:GetObject");
  });

  it("runs the claims agent on AgentCore with only Gateway tools bounded by Cedar", () => {
    const agentT = Template.fromStack(agent);
    agentT.hasResourceProperties("AWS::BedrockAgentCore::Harness", {
      HarnessName: "dockclock_claims_agent",
      Model: { BedrockModelConfig: Match.objectLike({ ModelId: config.agentModelId }) },
      Tools: [Match.objectLike({ Type: "agentcore_gateway" })],
      MaxIterations: 12,
    });
    agentT.hasResourceProperties("AWS::BedrockAgentCore::Gateway", { ProtocolType: "MCP", AuthorizerType: "AWS_IAM", PolicyEngineConfiguration: Match.objectLike({ Mode: "ENFORCE" }) });
    agentT.hasResourceProperties("AWS::BedrockAgentCore::GatewayTarget", { Name: "dockclock-tools" });
    agentT.resourceCountIs("AWS::BedrockAgentCore::Policy", 2);
    const policies = JSON.stringify(agentT.findResources("AWS::BedrockAgentCore::Policy"));
    expect(policies).toContain("dockclock-tools___send_detention_claim");
    expect(policies).toContain("context.input.amountCents <= 500000");
  });
});
