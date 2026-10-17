import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { encodeButtonPayload, encodeFlowToken } from "@dockclock/whatsapp";
import { COPY, type Language } from "./messages.js";
import { ddb, type Address } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const messaging = new SocialMessagingClient({ maxAttempts: 1 });
type Message = Record<string, unknown>;

export function addressValue(address: Address): string {
  return address.kind === "bsuid" ? address.id : address.e164;
}

function base(address: Address): Message {
  return { messaging_product: "whatsapp", recipient_type: "individual", ...(address.kind === "bsuid" ? { recipient: address.id } : { to: address.e164 }) };
}

export function textMessage(address: Address, body: string): Message {
  return { ...base(address), type: "text", text: { preview_url: false, body } };
}

export function locationRequest(address: Address, language: Language, step: "arrived" | "released"): Message {
  const copy = COPY[language];
  return {
    ...base(address),
    type: "interactive",
    interactive: { type: "location_request_message", body: { text: step === "arrived" ? copy.locationArrived : copy.locationReleased }, action: { name: "send_location" } },
  };
}

export function releaseButtons(address: Address, language: Language, loadId: string, nonce: string, facility: string, time: string): Message {
  const copy = COPY[language];
  return {
    ...base(address),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: copy.checkedIn(facility, time) },
      action: {
        buttons: [
          { type: "reply", reply: { id: encodeButtonPayload({ action: "released", loadId, nonce }), title: copy.released } },
          { type: "reply", reply: { id: encodeButtonPayload({ action: "dispatch", loadId, nonce }), title: copy.talkToDispatch } },
        ],
      },
    },
  };
}

export interface ReleaseFlowData {
  loadLabel: string;
  arrivedHint: string;
  releasedHint: string;
}

export function releaseFlowMessage(address: Address, language: Language, loadId: string, nonce: string, facility: string, data: ReleaseFlowData): Message {
  const copy = COPY[language];
  return {
    ...base(address),
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: copy.releaseFlowBody(facility) },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: encodeFlowToken(loadId, nonce),
          flow_id: env.releaseFlowId(),
          mode: env.flowMode(),
          flow_cta: copy.releaseFlowCta,
          flow_action: "navigate",
          flow_action_payload: {
            screen: "BOL_PHOTO",
            data: { load_label: data.loadLabel, arrived_hint: data.arrivedHint, released_hint: data.releasedHint },
          },
        },
      },
    },
  };
}

export const TEMPLATE_DISPATCH = "dockclock_load_dispatch";

export function dispatchTemplate(address: Address, language: Language, loadId: string, nonce: string, facility: string, appointment: string): Message {
  const quickReply = (index: number, action: "arrived" | "dispatch") => ({
    type: "button",
    sub_type: "quick_reply",
    index: String(index),
    parameters: [{ type: "payload", payload: encodeButtonPayload({ action, loadId, nonce }) }],
  });
  return {
    ...base(address),
    type: "template",
    template: {
      name: TEMPLATE_DISPATCH,
      language: { code: language },
      components: [
        { type: "body", parameters: [loadId, facility, appointment].map((text) => ({ type: "text", text })) },
        quickReply(0, "arrived"),
        quickReply(1, "dispatch"),
      ],
    },
  };
}

// Sends one message, and records End User Messaging's message id against the load so delivery and
// read receipts join back to it. Never retried blindly: a send that may have been accepted is
// surfaced for review instead of duplicated.
export async function send(address: Address, message: Message, purpose: string, loadId: string): Promise<string | null> {
  if (!env.driverReplies()) {
    log("send_skipped", { purpose, loadId, reason: "DRIVER_REPLIES off" });
    return null;
  }
  if (!env.driverAllowlist().has(addressValue(address))) {
    log("send_blocked", { purpose, loadId, reason: "recipient not on DRIVER_ALLOWLIST", recipientKind: address.kind });
    return null;
  }
  const out = await messaging.send(
    new SendWhatsAppMessageCommand({
      originationPhoneNumberId: env.originationPhoneId(),
      metaApiVersion: env.metaApiVersion(),
      message: Buffer.from(JSON.stringify(message)),
    }),
  );
  const messageId = out.messageId ?? null;
  log("send_accepted", { purpose, loadId, messageId });
  if (messageId) {
    await ddb.send(
      new PutCommand({ TableName: env.table(), Item: { ...keys.receipt(messageId), loadId, purpose, acceptedAt: new Date().toISOString() } }),
    );
  }
  return messageId;
}
