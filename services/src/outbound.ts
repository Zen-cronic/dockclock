import type { RcsMessageContent, RcsSuggestedAction } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { renderTemplate } from "@dockclock/whatsapp";
import type { Channel } from "@dockclock/evidence";
import { keys } from "./keys.js";

// What a recipient saw: the rendered text, button titles and Flow call to action of one outbound
// message. Never the recipient, never a button payload (payloads carry the load's nonce).
export interface SentMessage {
  kind: "template" | "text" | "buttons" | "location_request" | "flow" | "card" | "document" | "unknown";
  template?: { name: string; language: string };
  title?: string;
  text: string;
  footer?: string;
  buttons?: string[];
  flowCta?: string;
  // Every button, chip or call to action by what it does (the button titles above, typed).
  actions?: SentAction[];
  // A WhatsApp document message: the file name the recipient saw and the SHA-256 of the file's
  // bytes. The caption is `text`. Never the S3 key or the WhatsApp media id.
  document?: { filename: string; sha256?: string };
}

export interface SentAction {
  type: "quick_reply" | "flow_cta" | "send_location" | "rcs_reply" | "rcs_request_location" | "rcs_open_url" | "rcs_dial";
  title: string;
}

// Whose phone the message went to, by role: the driver's, or the dispatcher's. On a judge demo load
// the driver approves their own claim, so the approval request goes to the driver's phone.
export type Audience = "driver" | "dispatcher";

export interface SendRecord {
  pk: string;
  sk: string;
  kind: "send";
  messageId: string;
  channel: Channel;
  purpose: string;
  audience: Audience;
  sentAt: string;
  message: SentMessage;
  // A message DockClock composed but did not send, and why (a test number, replies off, STOP).
  status?: "not_sent";
  notSentReason?: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function templateParameters(components: unknown): string[] {
  const body = (Array.isArray(components) ? components : []).map(obj).find((c) => c.type === "body");
  return (Array.isArray(body?.parameters) ? body.parameters : []).map((p) => str(obj(p).text));
}

// A WhatsApp message body as sent (without the recipient fields send() adds).
export function renderWhatsApp(body: Json): SentMessage {
  if (body.type === "template") {
    const template = obj(body.template);
    const name = str(template.name);
    const language = str(obj(template.language).code);
    const rendered = renderTemplate(name, language, templateParameters(template.components));
    return {
      kind: "template",
      template: { name, language },
      text: rendered?.body ?? "",
      ...(rendered?.footer ? { footer: rendered.footer } : {}),
      ...(rendered?.buttons ? { buttons: rendered.buttons, actions: rendered.buttons.map((title) => ({ type: "quick_reply" as const, title })) } : {}),
    };
  }
  if (body.type === "text") return { kind: "text", text: str(obj(body.text).body) };
  if (body.type === "document") {
    const document = obj(body.document);
    return { kind: "document", text: str(document.caption), document: { filename: str(document.filename) } };
  }
  if (body.type === "interactive") {
    const interactive = obj(body.interactive);
    const text = str(obj(interactive.body).text);
    const action = obj(interactive.action);
    if (interactive.type === "button") {
      const buttons = (Array.isArray(action.buttons) ? action.buttons : []).map((b) => str(obj(obj(b).reply).title));
      return { kind: "buttons", text, buttons, actions: buttons.map((title) => ({ type: "quick_reply", title })) };
    }
    if (interactive.type === "location_request_message") return { kind: "location_request", text, buttons: ["Send location"], actions: [{ type: "send_location", title: "Send location" }] };
    if (interactive.type === "flow") {
      const flowCta = str(obj(action.parameters).flow_cta);
      return { kind: "flow", text, flowCta, actions: [{ type: "flow_cta", title: flowCta }] };
    }
  }
  return { kind: "unknown", text: "" };
}

// One RCS suggestion by what it does. The postback data (which carries the load's nonce) is not kept.
function suggestion(action: RcsSuggestedAction): SentAction {
  const a = action as { Reply?: { Text?: string }; RequestLocation?: { Text?: string }; OpenUrl?: { Text?: string }; DialPhone?: { Text?: string } };
  if (a.RequestLocation) return { type: "rcs_request_location", title: a.RequestLocation.Text ?? "" };
  if (a.OpenUrl) return { type: "rcs_open_url", title: a.OpenUrl.Text ?? "" };
  if (a.DialPhone) return { type: "rcs_dial", title: a.DialPhone.Text ?? "" };
  return { type: "rcs_reply", title: a.Reply?.Text ?? "" };
}

// An RCS message as sent: a rich card or a text, with its suggested replies and actions.
export function renderRcs(content: RcsMessageContent): SentMessage {
  const outer = (content.Suggestions ?? []).map(suggestion);
  const card = content.Content?.RichCard?.CardContent;
  const typed = (actions: SentAction[]) => (actions.length ? { buttons: actions.map((x) => x.title), actions } : {});
  if (card) {
    return { kind: "card", ...(card.Title ? { title: card.Title } : {}), text: card.Description ?? "", ...typed([...(card.Suggestions ?? []).map(suggestion), ...outer]) };
  }
  const text = content.Content?.TextMessage?.Body;
  if (text !== undefined) {
    const isLocation = outer.some((x) => x.type === "rcs_request_location");
    return { kind: isLocation ? "location_request" : "text", text, ...typed(outer) };
  }
  return { kind: "unknown", text: "" };
}

export function sendRecord(input: { loadId: string; messageId: string; channel: Channel; purpose: string; audience: Audience; sentAt: string; message: SentMessage; notSentReason?: string }): SendRecord {
  return {
    ...keys.send(input.loadId, input.sentAt, input.messageId),
    kind: "send",
    messageId: input.messageId,
    channel: input.channel,
    purpose: input.purpose,
    audience: input.audience,
    sentAt: input.sentAt,
    message: input.message,
    ...(input.notSentReason ? { status: "not_sent" as const, notSentReason: input.notSentReason } : {}),
  };
}

// Plain reasons for a message that was composed but not sent.
export const NOT_SENT = {
  repliesOff: "Not sent: driver messages are switched off in this deployment.",
  notAllowlisted: "Not sent: the recipient is a test number, and DockClock only messages allowlisted or DEMO-enrolled numbers.",
  optedOut: "Not sent: the driver replied STOP.",
  // The claim summary PDF sent back over WhatsApp (claim-receipt.ts).
  noPdf: "Not sent: the claim PDF was not stored, so there was no file to send.",
  uploadFailed: "Not sent: the claim PDF could not be uploaded to WhatsApp.",
  sendFailed: "Not sent: WhatsApp did not accept the message.",
  windowClosed: "Not sent: the driver has not written in the last 24 hours, and WhatsApp then allows only approved templates.",
  testLoad: "Not sent: a test load. Dispatch is only messaged when the test asks for it.",
  failed: "Not sent: the send stopped on an error.",
} as const;
