import type { RcsMessageContent, RcsSuggestedAction } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { renderTemplate } from "@dockclock/whatsapp";
import type { Channel } from "@dockclock/evidence";
import { keys } from "./keys.js";

// What a recipient saw: the rendered text, button titles and Flow call to action of one outbound
// message. Never the recipient, never a button payload (payloads carry the load's nonce).
export interface SentMessage {
  kind: "template" | "text" | "buttons" | "location_request" | "flow" | "card" | "unknown";
  template?: { name: string; language: string };
  title?: string;
  text: string;
  footer?: string;
  buttons?: string[];
  flowCta?: string;
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
      ...(rendered?.buttons ? { buttons: rendered.buttons } : {}),
    };
  }
  if (body.type === "text") return { kind: "text", text: str(obj(body.text).body) };
  if (body.type === "interactive") {
    const interactive = obj(body.interactive);
    const text = str(obj(interactive.body).text);
    const action = obj(interactive.action);
    if (interactive.type === "button") {
      const buttons = (Array.isArray(action.buttons) ? action.buttons : []).map((b) => str(obj(obj(b).reply).title));
      return { kind: "buttons", text, buttons };
    }
    if (interactive.type === "location_request_message") return { kind: "location_request", text, buttons: ["Send location"] };
    if (interactive.type === "flow") return { kind: "flow", text, flowCta: str(obj(action.parameters).flow_cta) };
  }
  return { kind: "unknown", text: "" };
}

function suggestionText(action: RcsSuggestedAction): string {
  const a = action as { Reply?: { Text?: string }; RequestLocation?: { Text?: string }; OpenUrl?: { Text?: string }; DialPhone?: { Text?: string } };
  return a.Reply?.Text ?? a.RequestLocation?.Text ?? a.OpenUrl?.Text ?? a.DialPhone?.Text ?? "";
}

// An RCS message as sent: a rich card or a text, with its suggested replies and actions.
export function renderRcs(content: RcsMessageContent): SentMessage {
  const outer = (content.Suggestions ?? []).map(suggestionText);
  const card = content.Content?.RichCard?.CardContent;
  if (card) {
    const buttons = [...(card.Suggestions ?? []).map(suggestionText), ...outer];
    return { kind: "card", ...(card.Title ? { title: card.Title } : {}), text: card.Description ?? "", ...(buttons.length ? { buttons } : {}) };
  }
  const text = content.Content?.TextMessage?.Body;
  if (text !== undefined) {
    const isLocation = (content.Suggestions ?? []).some((s) => "RequestLocation" in s && s.RequestLocation);
    return { kind: isLocation ? "location_request" : "text", text, ...(outer.length ? { buttons: outer } : {}) };
  }
  return { kind: "unknown", text: "" };
}

export function sendRecord(input: { loadId: string; messageId: string; channel: Channel; purpose: string; audience: Audience; sentAt: string; message: SentMessage }): SendRecord {
  return {
    ...keys.send(input.loadId, input.sentAt, input.messageId),
    kind: "send",
    messageId: input.messageId,
    channel: input.channel,
    purpose: input.purpose,
    audience: input.audience,
    sentAt: input.sentAt,
    message: input.message,
  };
}
