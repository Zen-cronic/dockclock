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
  fromEmail: "dockclock@example.com",
};

describe("stacks", () => {
  const { core, messaging, email } = buildApp(config, new App({ context: { "aws:cdk:bundling-stacks": [] } }));
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
    expect(definition).toContain("Await arrived");
    expect(definition).toContain("Await released");
    expect(definition).toContain("Await bol");
    // The arrival timeout comes from the execution input, measured from the appointment.
    expect(definition).toContain("TimeoutSecondsPath");
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

  it("lets only the seal function sign, and only ingest and dispatch send WhatsApp", () => {
    const policies = Object.values(msgT.findResources("AWS::IAM::Policy")).map((p) => JSON.stringify(p));
    expect(policies.filter((p) => p.includes("kms:Sign"))).toHaveLength(1);
    // Ingest replies in-window and dispatch sends the template; nothing else can message drivers.
    expect(policies.filter((p) => p.includes("social-messaging:SendWhatsAppMessage"))).toHaveLength(2);
    expect(policies.filter((p) => p.includes("social-messaging:GetWhatsAppMessageMedia"))).toHaveLength(1);
  });
});
