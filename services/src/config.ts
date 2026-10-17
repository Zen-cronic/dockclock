import type { ChannelConfig } from "@dockclock/whatsapp";

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
  driverAllowlist: () => new Set((process.env.DRIVER_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
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
