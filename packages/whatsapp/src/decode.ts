export interface ChannelConfig {
  account: string;
  topicArn: string;
  metaWabaId: string;
  metaPhoneId: string;
}

export interface WebhookEntry {
  id: string;
  changes?: Array<{ field?: string; value?: WebhookValue }>;
}

export interface WebhookValue {
  metadata?: { phone_number_id?: string };
  messages?: RawMessage[];
  statuses?: RawStatus[];
}

export interface RawMessage {
  id?: string;
  from?: string;
  from_user_id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    nfm_reply?: { response_json?: string | Record<string, unknown>; name?: string };
  };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  image?: { id?: string; mime_type?: string; sha256?: string };
  audio?: { id?: string; mime_type?: string; sha256?: string };
}

export interface RawStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string }>;
}

export class UntrustedEventError extends Error {
  constructor(readonly code: "UNTRUSTED_TOPIC" | "WRONG_ACCOUNT" | "WRONG_WABA" | "WRONG_AGENT") {
    super(code);
    this.name = "UntrustedEventError";
  }
}

export interface DecodedEvent {
  entry: WebhookEntry;
  // End User Messaging's id for the message a status refers to: the same id SendWhatsAppMessage
  // returned, so delivery receipts join to our own send records.
  eumMessageId: string | null;
}

// Unwraps SNS envelope -> End User Messaging Social event -> Meta webhook entry, refusing anything
// not published by our topic for our account and WhatsApp Business Account.
export function decodeEvent(body: string, config: ChannelConfig): DecodedEvent {
  const envelope = JSON.parse(body) as { Type?: string; TopicArn?: string; Message?: string };
  if (envelope.Type !== "Notification" || envelope.TopicArn !== config.topicArn || typeof envelope.Message !== "string") {
    throw new UntrustedEventError("UNTRUSTED_TOPIC");
  }
  const event = JSON.parse(envelope.Message) as { aws_account_id?: string; whatsAppWebhookEntry?: unknown; messageId?: unknown };
  if (event.aws_account_id !== config.account) throw new UntrustedEventError("WRONG_ACCOUNT");
  const raw = event.whatsAppWebhookEntry;
  const entry = (typeof raw === "string" ? JSON.parse(raw) : raw) as WebhookEntry | undefined;
  if (entry?.id !== config.metaWabaId) throw new UntrustedEventError("WRONG_WABA");
  return { entry, eumMessageId: typeof event.messageId === "string" ? event.messageId : null };
}

export function decode(body: string, config: ChannelConfig): WebhookEntry {
  return decodeEvent(body, config).entry;
}
