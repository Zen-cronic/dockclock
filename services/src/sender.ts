import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import type { Step } from "./lifecycle.js";
import type { Address } from "./store.js";
import { env, log } from "./config.js";

const messaging = new SocialMessagingClient({ maxAttempts: 1 });

function recipient(address: Address): Record<string, string> {
  return address.kind === "bsuid" ? { recipient: address.id } : { to: address.e164 };
}

export function locationRequest(address: Address, step: Step): Record<string, unknown> {
  const text =
    step === "arrived"
      ? "Share your location to start the dock clock. Only send it while parked."
      : "Share your location once more to stop the dock clock.";
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...recipient(address),
    type: "interactive",
    interactive: { type: "location_request_message", body: { text }, action: { name: "send_location" } },
  };
}

export function textMessage(address: Address, body: string): Record<string, unknown> {
  return { messaging_product: "whatsapp", recipient_type: "individual", ...recipient(address), type: "text", text: { preview_url: false, body } };
}

// Sends one free-form message inside the driver's 24-hour window. Never retried blindly: a send
// that may have been accepted is surfaced for review instead of duplicated.
export async function send(message: Record<string, unknown>, purpose: string, loadId: string): Promise<string | null> {
  if (!env.driverReplies()) {
    log("send_skipped", { purpose, loadId, reason: "DRIVER_REPLIES off" });
    return null;
  }
  const out = await messaging.send(
    new SendWhatsAppMessageCommand({
      originationPhoneNumberId: env.originationPhoneId(),
      metaApiVersion: env.metaApiVersion(),
      message: Buffer.from(JSON.stringify(message)),
    }),
  );
  log("send_accepted", { purpose, loadId, messageId: out.messageId });
  return out.messageId ?? null;
}
