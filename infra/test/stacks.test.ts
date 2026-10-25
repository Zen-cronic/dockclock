import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../lib/app.js";
import { DESK_PLACEHOLDER_CONTEXT, deskSource } from "../lib/desk-stack.js";

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
  consoleUrl: "https://console.example.com",
};

describe("stacks", () => {
  // The placeholder is asked for, so the stacks build without a site build.
  const { core, messaging, email, agent, desk } = buildApp(config, new App({ context: { "aws:cdk:bundling-stacks": [], [DESK_PLACEHOLDER_CONTEXT]: "1" } }));
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
    // The retake fires on the tool's own legible flag, which sits under reading (a wrong path never matched, so no retake was ever asked).
    expect(definition).toContain('\\"Variable\\":\\"$.bolReading.result.reading.legible\\"');
    expect(definition).not.toContain('$.bolReading.result.legible');
    expect(definition).toContain("Await arrived");
    expect(definition).toContain("Await released");
    expect(definition).toContain("Await bol");
    // The arrival timeout comes from the execution input, measured from the appointment.
    expect(definition).toContain('\\"TimeoutSecondsPath\\":\\"$.arrivalTimeoutSeconds\\"');
    expect(definition).toContain("Seal failed");
    expect(definition).toContain("Seal evidence");
    // A closed load records when it closed, so a load never released stops its clock there.
    expect(definition).toContain("closedAt = :t");
    expect(definition).toContain("$$.State.EnteredTime");
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

  it("lets only the outcome teller upload the claim PDF to WhatsApp, reading claim PDFs and nothing else", () => {
    const policies = Object.entries(msgT.findResources("AWS::IAM::Policy"));
    const uploaders = policies.filter(([, p]) => JSON.stringify(p).includes("social-messaging:PostWhatsAppMessageMedia"));
    expect(uploaders.map(([id]) => id)).toEqual([expect.stringMatching(/^TellOutcomeServiceRoleDefaultPolicy/)]);
    const statements = uploaders[0]![1].Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>;
    const upload = statements.find((s) => s.Action === "social-messaging:PostWhatsAppMessageMedia")!;
    expect(JSON.stringify(upload.Resource)).toContain(`phone-number-id/${config.originationPhoneId.replace(/^phone-number-id-/, "")}`);
    const reads = statements.filter((s) => [s.Action].flat().some((a) => a.startsWith("s3:")));
    expect(reads.map((s) => s.Action)).toEqual(["s3:GetObject"]);
    expect(JSON.stringify(reads[0]!.Resource)).toContain("/packs/*/claim.pdf");
    // Every send is recorded on the load, so the role writes the table.
    expect(JSON.stringify(statements)).toContain("dynamodb:PutItem");
    const fn = Object.values(msgT.findResources("AWS::Lambda::Function")).find((f) => JSON.stringify(f.Properties.Role).includes("TellOutcomeServiceRole"))!;
    expect(fn.Properties.Environment.Variables.EVIDENCE_BUCKET).toBeDefined();
    expect(fn.Properties.Timeout).toBe(60);
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

  it("gives every Lambda the configured console address, so emails, PDFs and links never hardcode it", () => {
    for (const stack of [agent, messaging]) {
      const fns = Object.values(Template.fromStack(stack).findResources("AWS::Lambda::Function")) as Array<{ Properties: { Handler?: string; Environment?: { Variables?: Record<string, unknown> } } }>;
      const ours = fns.filter((f) => f.Properties.Environment?.Variables?.NODE_OPTIONS === "--enable-source-maps");
      expect(ours.length).toBeGreaterThan(0);
      for (const f of ours) expect(f.Properties.Environment?.Variables?.CONSOLE_URL).toBe(config.consoleUrl);
    }
  });

  it("records agent runs and keeps sent emails beside the packs", () => {
    const agentT = Template.fromStack(agent);
    agentT.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "dockclock-invoke-agent",
      Environment: { Variables: Match.objectLike({ TABLE_NAME: Match.anyValue(), AGENT_MODEL_ID: config.agentModelId }) },
    });
    const noticeEnv = JSON.stringify(msgT.findResources("AWS::Lambda::Function"));
    expect(noticeEnv).toContain("EVIDENCE_BUCKET");
    // Raw MIME sends are authorized as ses:SendRawEmail (found live: SendEmail alone is refused).
    const noticePolicy = Object.entries(msgT.findResources("AWS::IAM::Policy")).find(([id]) => id.startsWith("NoticeServiceRoleDefaultPolicy"));
    expect(JSON.stringify(noticePolicy)).toContain("ses:SendRawEmail");
  });

  it("indexes only demo-workspace loads for the read API", () => {
    coreT.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: "byWorkspace",
          KeySchema: [
            { AttributeName: "ws", KeyType: "HASH" },
            { AttributeName: "createdAt", KeyType: "RANGE" },
          ],
        }),
      ],
    });
  });

  it("serves the judge desk from a private bucket through CloudFront over HTTPS only", () => {
    const deskT = Template.fromStack(desk);
    deskT.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    // One for the site bucket, one for the API's function URL.
    deskT.resourceCountIs("AWS::CloudFront::OriginAccessControl", 2);
    deskT.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ DefaultRootObject: "index.html", DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }) }),
    });
    deskT.hasOutput("DeskUrl", {});
  });

  it("serves the read-only console API at /api/* on the desk's own distribution", () => {
    const deskT = Template.fromStack(desk);
    deskT.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ CacheBehaviors: [Match.objectLike({ PathPattern: "/api/*", AllowedMethods: ["GET", "HEAD"], ViewerProtocolPolicy: "redirect-to-https" })] }),
    });
    deskT.hasResourceProperties("AWS::Lambda::Url", { AuthType: "AWS_IAM" });
    deskT.hasResourceProperties("AWS::Lambda::Function", {
      ReservedConcurrentExecutions: 50,
      Environment: { Variables: Match.objectLike({ TABLE_NAME: Match.anyValue(), EVIDENCE_BUCKET: Match.anyValue(), MEDIA_BUCKET: Match.anyValue(), EVIDENCE_SPKI_SHA256: Match.stringLikeRegexp("^[0-9a-f]{64}$") }) },
    });
    // The API's own role reads only (the site upload role is separate and writes the site bucket).
    const apiPolicies = Object.entries(deskT.findResources("AWS::IAM::Policy")).filter(([id]) => id.startsWith("ReadApi"));
    expect(apiPolicies).toHaveLength(1);
    const apiPolicy = JSON.stringify(apiPolicies);
    expect(apiPolicy).toContain("dynamodb:Query");
    expect(apiPolicy).not.toMatch(/dynamodb:(Put|Update|Delete|Scan|BatchWrite)|s3:(Put|Delete)/);
  });
});

describe("desk source", () => {
  const root = () => {
    const dir = mkdtempSync(join(tmpdir(), "desk-"));
    mkdirSync(join(dir, "infra", "desk-placeholder"), { recursive: true });
    return dir;
  };

  it("serves the built site when it exists", () => {
    const dir = root();
    mkdirSync(join(dir, "site", "dist"), { recursive: true });
    writeFileSync(join(dir, "site", "dist", "index.html"), "<!doctype html>");
    expect(deskSource(dir, false)).toBe(join(dir, "site", "dist"));
  });

  it("refuses to deploy the placeholder over the live console unless asked", () => {
    const dir = root();
    expect(() => deskSource(dir, false)).toThrow(/site\/dist\/index.html is missing.*DOCKCLOCK_DESK_PLACEHOLDER=1/);
    expect(deskSource(dir, true)).toBe(join(dir, "infra", "desk-placeholder"));
  });
});
