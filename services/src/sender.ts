import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { encodeButtonPayload, encodeFlowToken, normalizeE164 } from "@dockclock/whatsapp";
import { COPY, type Language } from "./messages.js";
import { ddb, type Address } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

// Retries and timeouts keep one slow call from stalling a batch. Driver prompts are safe to
// receive twice (a second location request or button changes nothing), so a retried send is
// preferable to a lost one; the outbox in ingest.ts replays anything that still fails.
const messaging = new SocialMessagingClient({ maxAttempts: 3, requestHandler: { requestTimeout: 5000, connectionTimeout: 2000 } });

// Message bodies without a recipient: send() adds the recipient from the same address it checked.
type Body = Record<string, unknown>;

export interface Target {
  address: Address;
  driverKey: string;
}

export function canonical(address: Address): Address {
  if (address.kind === "bsuid") return address;
  const e164 = normalizeE164(address.e164);
  if (!e164) throw new Error("invalid phone number");
  return { kind: "phone", e164 };
}

export function addressValue(address: Address): string {
  return address.kind === "bsuid" ? address.id : address.e164;
}

function recipient(address: Address): Body {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...(address.kind === "bsuid" ? { recipient: address.id } : { to: address.e164 }),
  };
}

export function textMessage(body: string): Body {
  return { type: "text", text: { preview_url: false, body } };
}

export function locationRequest(language: Language, step: "arrived" | "released"): Body {
  const copy = COPY[language];
  return {
    type: "interactive",
    interactive: { type: "location_request_message", body: { text: step === "arrived" ? copy.locationArrived : copy.locationReleased }, action: { name: "send_location" } },
  };
}

export function releaseButtons(language: Language, loadId: string, nonce: string, facility: string, time: string): Body {
  const copy = COPY[language];
  return {
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

export function releaseFlowMessage(language: Language, loadId: string, nonce: string, facility: string, data: ReleaseFlowData): Body {
  const copy = COPY[language];
  return {
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

export function dispatchTemplate(language: Language, loadId: string, nonce: string, facility: string, appointment: string): Body {
  const quickReply = (index: number, action: "arrived" | "dispatch") => ({
    type: "button",
    sub_type: "quick_reply",
    index: String(index),
    parameters: [{ type: "payload", payload: encodeButtonPayload({ action, loadId, nonce }) }],
  });
  return {
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

export async function isOptedOut(driverKey: string): Promise<boolean> {
  const out = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.optOut(driverKey), ConsistentRead: true }));
  return out.Item !== undefined;
}

// Sends one message to one driver. Checks, in order: replies enabled, the allowlist, and the
// driver's opt-out; the recipient is then taken from the very address that passed those checks.
// The send is recorded under End User Messaging's message id so receipts join back to the load.
export async function send(target: Target, body: Body, purpose: string, loadId: string, options: { ignoreOptOut?: boolean } = {}): Promise<string | null> {
  if (!env.driverReplies()) {
    log("send_skipped", { purpose, loadId, reason: "DRIVER_REPLIES off" });
    return null;
  }
  const address = canonical(target.address);
  if (!env.driverAllowlist().has(addressValue(address))) {
    log("send_blocked", { purpose, loadId, reason: "recipient not on DRIVER_ALLOWLIST", recipientKind: address.kind });
    return null;
  }
  if (!options.ignoreOptOut && (await isOptedOut(target.driverKey))) {
    log("send_blocked", { purpose, loadId, reason: "driver opted out" });
    return null;
  }
  const out = await messaging.send(
    new SendWhatsAppMessageCommand({
      originationPhoneNumberId: env.originationPhoneId(),
      metaApiVersion: env.metaApiVersion(),
      message: Buffer.from(JSON.stringify({ ...recipient(address), ...body })),
    }),
  );
  const messageId = out.messageId ?? null;
  log("send_accepted", { purpose, loadId, messageId });
  if (messageId) {
    // Merge, never replace: a status webhook may already have written delivery fields.
    await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.receipt(messageId),
        UpdateExpression: "SET loadId = :l, purpose = :p, acceptedAt = if_not_exists(acceptedAt, :a)",
        ExpressionAttributeValues: { ":l": loadId, ":p": purpose, ":a": new Date().toISOString() },
      }),
    );
  }
  return messageId;
}
