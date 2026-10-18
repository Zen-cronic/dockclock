import { registerFacility, type Facility } from "@dockclock/evidence";
import type { RcsConfig } from "@dockclock/rcs";
import { normalizeE164, type ChannelConfig } from "@dockclock/whatsapp";

// A private demo yard arrives as JSON in DEMO_FACILITY (set from the operator's gitignored .env),
// so its coordinates never enter the repository.
if (process.env.DEMO_FACILITY) registerFacility(JSON.parse(process.env.DEMO_FACILITY) as Facility);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

export const env = {
  table: () => required("TABLE_NAME"),
  bucket: () => required("EVIDENCE_BUCKET"),
  keyId: () => required("EVIDENCE_KEY_ARN"),
  stateMachineArn: () => required("STATE_MACHINE_ARN"),
  identitySecretArn: () => required("IDENTITY_SECRET_ARN"),
  originationPhoneId: () => required("ORIGINATION_PHONE_ID"),
  metaApiVersion: () => process.env.META_API_VERSION ?? "v23.0",
  mediaBucket: () => required("MEDIA_BUCKET"),
  releaseFlowId: () => required("RELEASE_FLOW_ID"),
  flowMode: () => (process.env.FLOW_MODE === "published" ? "published" : "draft"),
  driverReplies: () => process.env.DRIVER_REPLIES === "on",
  // Comma-separated E.164 numbers or BSUIDs that may receive driver messages. Empty means nobody.
  // Phone numbers are normalized so "+1 416-555-0100" and "14165550100" are the same entry.
  driverAllowlist: () =>
    new Set(
      (process.env.DRIVER_ALLOWLIST ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (/^[+\d\s().-]+$/.test(s) ? (normalizeE164(s) ?? s) : s)),
    ),
  dispatchEmail: () => required("DISPATCH_EMAIL"),
  fromEmail: () => required("FROM_EMAIL"),
  configurationSet: () => required("SES_CONFIGURATION_SET"),
  // RCS is optional: without an agent id, loads stay on WhatsApp and failures go to dispatch.
  rcs: (): RcsConfig | null =>
    process.env.RCS_AGENT_ID && process.env.RCS_TOPIC_ARN
      ? { agentId: process.env.RCS_AGENT_ID, topicArn: process.env.RCS_TOPIC_ARN, mediaBucket: required("MEDIA_BUCKET") }
      : null,
  rcsConfigurationSet: () => process.env.RCS_CONFIGURATION_SET ?? "",
  channel: (): ChannelConfig => ({
    account: required("ACCOUNT_ID"),
    topicArn: required("TOPIC_ARN"),
    metaWabaId: required("META_WABA_ID"),
    metaPhoneId: required("META_PHONE_ID"),
  }),
};

export function log(kind: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ kind, ...fields }));
}
