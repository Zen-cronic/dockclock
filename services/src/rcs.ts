import type { RcsMessageContent, RcsSuggestedAction } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { encodeButtonPayload, type ButtonAction } from "@dockclock/whatsapp";
import { COPY, type Language } from "./messages.js";

// RCS equivalents of the WhatsApp driver prompts. Suggested replies carry the same dc1 payloads as
// WhatsApp buttons, so a tap on either channel is the same event to the lifecycle.
function reply(text: string, action: ButtonAction, loadId: string, nonce: string): RcsSuggestedAction {
  return { Reply: { Text: text, PostbackData: encodeButtonPayload({ action, loadId, nonce }) } };
}

// Standalone cards keep their suggestions visible after later messages, so Arrived and Released
// stay one tap away however long the driver waits at the door.
function card(title: string, description: string, suggestions: RcsSuggestedAction[]): RcsMessageContent {
  return { Content: { RichCard: { CardOrientation: "VERTICAL", CardContent: { Title: title, Description: description, Suggestions: suggestions } } } };
}

export function rcsDispatchCard(language: Language, loadId: string, nonce: string, facility: string, appointment: string): RcsMessageContent {
  const copy = COPY[language];
  return card(copy.rcs.dispatchTitle(loadId), copy.rcs.dispatch(facility, appointment), [
    reply(copy.rcs.arrived, "arrived", loadId, nonce),
    reply(copy.talkToDispatch, "dispatch", loadId, nonce),
  ]);
}

export function rcsReleaseOffer(language: Language, loadId: string, nonce: string, facility: string, time: string): RcsMessageContent {
  const copy = COPY[language];
  return card(copy.rcs.dispatchTitle(loadId), copy.checkedIn(facility, time), [
    reply(copy.released, "released", loadId, nonce),
    reply(copy.talkToDispatch, "dispatch", loadId, nonce),
  ]);
}

// RequestLocation opens the phone's share-location sheet; the pin arrives as its own inbound event.
// Its postback is deliberately not a dc1 payload, so the tap itself changes nothing.
export function rcsLocationRequest(language: Language, step: "arrived" | "released"): RcsMessageContent {
  const copy = COPY[language];
  return {
    Content: { TextMessage: { Body: step === "arrived" ? copy.locationArrived : copy.locationReleased } },
    Suggestions: [{ RequestLocation: { Text: copy.rcs.shareLocation, PostbackData: `location_request.${step}` } }],
  };
}

export function rcsBolRequest(language: Language, facility: string, time: string): RcsMessageContent {
  return rcsText(COPY[language].rcs.bolRequest(facility, time));
}

export function rcsText(body: string): RcsMessageContent {
  return { Content: { TextMessage: { Body: body } } };
}
