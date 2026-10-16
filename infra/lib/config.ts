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
  };
}
