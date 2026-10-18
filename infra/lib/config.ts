export interface DockClockConfig {
  account: string;
  region: string;
  // Existing End User Messaging Social resources, created outside this app and reused.
  whatsappEventsTopicArn: string;
  originationPhoneId: string;
  metaWabaId: string;
  metaPhoneId: string;
  metaApiVersion: string;
  driverReplies: "on" | "off";
  driverAllowlist: string;
  releaseFlowId: string;
  flowMode: "draft" | "published";
  // Escalations go to dispatch by email. In the SES sandbox both must be verified identities.
  dispatchEmail: string;
  dispatcherPhone: string;
  fromEmail: string;
  // Existing AWS RCS agent (rcs-...) for drivers without WhatsApp and for failover. Empty: no RCS.
  rcsAgentId: string;
  // Optional private facility JSON ({ id, name, timeZone, polygon }) passed through to the Lambdas.
  demoFacility: string;
  // The claims agent: model, sender and the counterparty mailboxes (SES sandbox: verified test aliases).
  agentModelId: string;
  claimsFromEmail: string;
  counterpartyEmailBroker: string;
  counterpartyEmailShipper: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name} (see .env.example)`);
  return value;
}

export function configFromEnv(): DockClockConfig {
  return {
    account: required("DOCKCLOCK_ACCOUNT"),
    region: process.env.DOCKCLOCK_REGION ?? "us-east-1",
    whatsappEventsTopicArn: required("DOCKCLOCK_WHATSAPP_TOPIC_ARN"),
    originationPhoneId: required("DOCKCLOCK_ORIGINATION_PHONE_ID"),
    metaWabaId: required("DOCKCLOCK_META_WABA_ID"),
    metaPhoneId: required("DOCKCLOCK_META_PHONE_ID"),
    metaApiVersion: process.env.DOCKCLOCK_META_API_VERSION ?? "v23.0",
    driverReplies: process.env.DOCKCLOCK_DRIVER_REPLIES === "on" ? "on" : "off",
    driverAllowlist: process.env.DOCKCLOCK_DRIVER_ALLOWLIST ?? "",
    releaseFlowId: required("DOCKCLOCK_RELEASE_FLOW_ID"),
    flowMode: process.env.DOCKCLOCK_FLOW_MODE === "published" ? "published" : "draft",
    dispatchEmail: required("DOCKCLOCK_DISPATCH_EMAIL"),
    dispatcherPhone: required("DOCKCLOCK_DISPATCHER_PHONE"),
    fromEmail: required("DOCKCLOCK_FROM_EMAIL"),
    demoFacility: process.env.DOCKCLOCK_DEMO_FACILITY ?? "",
    agentModelId: process.env.DOCKCLOCK_AGENT_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    claimsFromEmail: required("DOCKCLOCK_CLAIMS_FROM_EMAIL"),
    counterpartyEmailBroker: required("DOCKCLOCK_COUNTERPARTY_EMAIL_BROKER"),
    counterpartyEmailShipper: required("DOCKCLOCK_COUNTERPARTY_EMAIL_SHIPPER"),
    rcsAgentId: process.env.DOCKCLOCK_RCS_AGENT_ID ?? "",
  };
}
