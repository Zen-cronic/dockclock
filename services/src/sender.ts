import { PinpointSMSVoiceV2Client, SendRcsMessageCommand, type RcsMessageContent } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { PostWhatsAppMessageMediaCommand, SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { encodeButtonPayload, encodeFlowToken, normalizeE164 } from "@dockclock/whatsapp";
import { COPY, type Language } from "./messages.js";
import { rcsDispatchCard } from "./rcs.js";
import type { Channel } from "@dockclock/evidence";
import { ddb, type Address } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";
import { randomBytes } from "node:crypto";
import { NOT_SENT, renderRcs, renderWhatsApp, sendRecord, type Audience, type SentMessage } from "./outbound.js";

// Retries and timeouts keep one slow call from stalling a batch. Driver prompts are safe to
// receive twice (a second location request or button changes nothing), so a retried send is
// preferable to a lost one; the outbox in ingest.ts replays anything that still fails.
const messaging = new SocialMessagingClient({ maxAttempts: 3, requestHandler: { requestTimeout: 5000, connectionTimeout: 2000 } });
const sms = new PinpointSMSVoiceV2Client({ maxAttempts: 3, requestHandler: { requestTimeout: 5000, connectionTimeout: 2000 } });

// Message bodies without a recipient: send() adds the recipient from the same address it checked.
export type Body = Record<string, unknown>;

export interface Target {
  address: Address;
  driverKey: string;
}

// A send that sent nothing: it stopped before the provider call, or the provider refused it outright
// (sendDocument). `reason` is the plain words the load's conversation shows (NOT_SENT). `permanent`:
// the same send would stop the same way on every retry (a deployment setting, an address that cannot
// be reached, a refusal), so retrying cannot help.
export class SendNotStarted extends Error {
  override name = "SendNotStarted";
  constructor(
    message: string,
    readonly reason: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

export function canonical(address: Address): Address {
  if (address.kind === "bsuid") return address;
  const e164 = normalizeE164(address.e164);
  if (!e164) throw new SendNotStarted("invalid phone number", NOT_SENT.badNumber, true);
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

// A WhatsApp document message for a file already uploaded with PostWhatsAppMessageMedia.
export function documentMessage(mediaId: string, filename: string, caption: string): Body {
  return { type: "document", document: { id: mediaId, filename, caption } };
}

// `stoppedAt` is the zone-labelled time of the Released tap, quoted in the release request.
export function locationRequest(language: Language, step: "arrived" | "released", stoppedAt = ""): Body {
  const copy = COPY[language];
  return {
    type: "interactive",
    interactive: { type: "location_request_message", body: { text: step === "arrived" ? copy.locationArrived : copy.locationReleased(stoppedAt) }, action: { name: "send_location" } },
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
  // Zone-labelled release time for the message body ("16:02 EDT"); the hints below are plain HH:MM
  // because the Flow's time fields take them as they are.
  releasedAt: string;
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
      body: { text: copy.releaseFlowBody(facility, data.releasedAt) },
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

// A judge who texted DEMO is enrolled for 24 hours (see demo.ts).
export async function isDemoEnrolled(driverKey: string): Promise<boolean> {
  const out = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.demoUser(driverKey) }));
  return typeof out.Item?.expiresAt === "string" && Date.parse(out.Item.expiresAt) > Date.now();
}

// How far a send got: "gates" until the provider call starts, "sending" while it may have gone
// out, "refused" when the provider answered that it did not take the message (nothing went),
// "accepted" once the provider returned a message id. A caller that must know which side of the
// send call an error came from passes one in and reads it after a throw. `recorded` is set once the
// load's own row for the message (sent, or not sent with the reason) is written; both writes are
// best effort, so a caller replacing an earlier row reads it before deleting that row.
export interface SendProgress {
  stage: "gates" | "sending" | "refused" | "accepted";
  recorded?: boolean;
}

// The provider answered on the first attempt with a client error other than a timeout or a throttle
// (AccessDeniedByMetaException, ValidationException, InvalidParametersException): the message did
// not go, and the same call would be refused again. A call the SDK retried may have gone on an
// earlier attempt, and a timeout, a throttle, a 5xx or a network error says nothing about it.
export function refusedOutright(error: unknown): boolean {
  const meta = (error as { $metadata?: { httpStatusCode?: number; attempts?: number } } | null)?.$metadata;
  const status = meta?.httpStatusCode;
  if (typeof status !== "number" || status < 400 || status >= 500 || status === 408 || status === 429) return false;
  return (meta?.attempts ?? 1) <= 1;
}

// audience: who the message is for, by role (default the driver); recorded with the send.
type SendOptions = { ignoreOptOut?: boolean; audience?: Audience; progress?: SendProgress };

const mark = (options: SendOptions, stage: SendProgress["stage"]) => {
  if (options.progress) options.progress.stage = stage;
};

const noteRecorded = (options: SendOptions, recorded: boolean) => {
  if (options.progress && recorded) options.progress.recorded = true;
};

// The gates every driver message passes, whatever the channel, in order: replies enabled, the
// allowlist (or a judge's 24-hour demo enrolment), and the driver's opt-out. Returns the canonical
// address that passed, or the reason it did not.
async function cleared(target: Target, purpose: string, loadId: string, options: SendOptions): Promise<{ address: Address } | { blocked: string }> {
  if (!env.driverReplies()) {
    log("send_skipped", { purpose, loadId, reason: "DRIVER_REPLIES off" });
    return { blocked: NOT_SENT.repliesOff };
  }
  const address = canonical(target.address);
  if (!env.driverAllowlist().has(addressValue(address)) && !(await isDemoEnrolled(target.driverKey))) {
    log("send_blocked", { purpose, loadId, reason: "recipient not on DRIVER_ALLOWLIST", recipientKind: address.kind });
    return { blocked: NOT_SENT.notAllowlisted };
  }
  if (!options.ignoreOptOut && (await isOptedOut(target.driverKey))) {
    log("send_blocked", { purpose, loadId, reason: "driver opted out" });
    return { blocked: NOT_SENT.optedOut };
  }
  return { address };
}

// A message the gates stopped is still recorded under its load, marked not sent with the reason,
// so a test load's conversation shows what DockClock would have said. Best effort, like recordSend.
// Returns the row's key, or null when nothing was written.
export async function recordBlocked(loadId: string, purpose: string, channel: Channel, message: SentMessage, audience: Audience, reason: string): Promise<{ pk: string; sk: string } | null> {
  if (loadId === "-") return null;
  try {
    const messageId = `not-sent-${randomBytes(6).toString("hex")}`;
    const item = sendRecord({ loadId, messageId, channel, purpose, audience, sentAt: new Date().toISOString(), message, notSentReason: reason });
    await ddb.send(new PutCommand({ TableName: env.table(), Item: item }));
    return { pk: item.pk, sk: item.sk };
  } catch (error) {
    log("send_record_failed", { purpose, loadId, error: (error as Error).name });
    return null;
  }
}

// Records the send under End User Messaging's message id so receipts join back to the load.
// Merge, never replace: a status event may already have written delivery fields. The load's own
// partition also gets what the recipient saw (SEND#), without the recipient. That copy is evidence
// for the timeline, not control state, so a failure to write it is logged and never fails the send:
// a thrown error here would make the outbox send the message again.
// Returns whether the load's row was written.
async function recordSend(messageId: string, loadId: string, purpose: string, channel: Channel, message: SentMessage, audience: Audience): Promise<boolean> {
  const acceptedAt = new Date().toISOString();
  await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.receipt(messageId),
      UpdateExpression: "SET loadId = :l, purpose = :p, channel = :c, acceptedAt = if_not_exists(acceptedAt, :a)",
      ExpressionAttributeValues: { ":l": loadId, ":p": purpose, ":c": channel, ":a": acceptedAt },
    }),
  );
  if (loadId === "-") return false;
  try {
    await ddb.send(new PutCommand({ TableName: env.table(), Item: sendRecord({ loadId, messageId, channel, purpose, audience, sentAt: acceptedAt, message }) }));
    return true;
  } catch (error) {
    log("send_record_failed", { purpose, loadId, messageId, error: (error as Error).name });
    return false;
  }
}

// Sends one WhatsApp message to one driver. The recipient is taken from the very address that
// passed the gates.
export async function send(target: Target, body: Body, purpose: string, loadId: string, options: SendOptions = {}): Promise<string | null> {
  const gate = await cleared(target, purpose, loadId, options);
  if ("blocked" in gate) {
    noteRecorded(options, (await recordBlocked(loadId, purpose, "whatsapp", renderWhatsApp(body), options.audience ?? "driver", gate.blocked)) !== null);
    return null;
  }
  const address = gate.address;
  mark(options, "sending");
  const out = await messaging.send(
    new SendWhatsAppMessageCommand({
      originationPhoneNumberId: env.originationPhoneId(),
      metaApiVersion: env.metaApiVersion(),
      message: Buffer.from(JSON.stringify({ ...recipient(address), ...body })),
    }),
  );
  const messageId = out.messageId ?? null;
  if (messageId) mark(options, "accepted");
  log("send_accepted", { purpose, loadId, messageId, channel: "whatsapp" });
  if (messageId) noteRecorded(options, await recordSend(messageId, loadId, purpose, "whatsapp", renderWhatsApp(body), options.audience ?? "driver"));
  return messageId;
}

// A file in S3 to send as a WhatsApp document: the object, the name the recipient sees, a caption,
// and the SHA-256 of the bytes (kept with the send record so the console can show it). The hash may
// be a function that reads it, called only once the gates pass, so a read that fails never stands in
// for a gate's answer. `upload` lets a caller sending one file to several people upload it once and
// reuse the media id.
export interface DocumentFile {
  bucket: string;
  key: string;
  filename: string;
  caption: string;
  sha256: string | (() => Promise<string>);
  upload?: () => Promise<string | undefined>;
}

// PostWhatsAppMessageMedia reads the object from S3 (with this function's own S3 permission) and
// returns a media id, or undefined when the upload failed (logged).
export async function uploadMedia(bucket: string, key: string, purpose: string, loadId: string): Promise<string | undefined> {
  try {
    const upload = await messaging.send(new PostWhatsAppMessageMediaCommand({ originationPhoneNumberId: env.originationPhoneId(), sourceS3File: { bucketName: bucket, key } }));
    return upload.mediaId ?? undefined;
  } catch (error) {
    log("media_upload_failed", { purpose, loadId, error: (error as Error).name });
    return undefined;
  }
}

// Sends one file as a WhatsApp document through the same gates as send(): the gates first, so a
// blocked recipient never causes a hash read or an upload (its not-sent row carries the hash only
// when it is already known); then PostWhatsAppMessageMedia reads the object from S3
// (with this function's own S3 permission) and returns a media id; then SendWhatsAppMessage sends
// the document. A recipient the gates stopped is recorded as not sent and gets null. A failed
// upload throws SendNotStarted (nothing went; the caller records it). A send the provider refused
// outright (refusedOutright) throws a permanent SendNotStarted with options.progress at "refused":
// nothing went, and a retry would be refused the same way. Any other throw from the send call, or a
// reply without a message id, may have sent the document, so it is rethrown with options.progress
// at "sending", and nothing is recorded as not sent.
export async function sendDocument(target: Target, file: DocumentFile, purpose: string, loadId: string, options: SendOptions = {}): Promise<string | null> {
  const audience = options.audience ?? "driver";
  const shownWith = (sha256: string | undefined) => ({ kind: "document" as const, text: file.caption, document: { filename: file.filename, ...(sha256 ? { sha256 } : {}) } });
  const gate = await cleared(target, purpose, loadId, options);
  if ("blocked" in gate) {
    noteRecorded(options, (await recordBlocked(loadId, purpose, "whatsapp", shownWith(typeof file.sha256 === "string" ? file.sha256 : undefined), audience, gate.blocked)) !== null);
    return null;
  }
  const shown = shownWith(typeof file.sha256 === "string" ? file.sha256 : await file.sha256());
  const mediaId = file.upload ? await file.upload() : await uploadMedia(file.bucket, file.key, purpose, loadId);
  if (!mediaId) throw new SendNotStarted("media upload failed", NOT_SENT.uploadFailed, false);
  mark(options, "sending");
  let messageId: string | null;
  try {
    const out = await messaging.send(
      new SendWhatsAppMessageCommand({
        originationPhoneNumberId: env.originationPhoneId(),
        metaApiVersion: env.metaApiVersion(),
        message: Buffer.from(JSON.stringify({ ...recipient(gate.address), ...documentMessage(mediaId, file.filename, file.caption) })),
      }),
    );
    messageId = out.messageId ?? null;
  } catch (error) {
    const refused = refusedOutright(error);
    log("send_failed", { purpose, loadId, channel: "whatsapp", error: (error as Error).name, refused });
    if (!refused) throw error;
    mark(options, "refused");
    throw new SendNotStarted(`WhatsApp refused the document (${(error as Error).name})`, NOT_SENT.sendRefused, true);
  }
  if (!messageId) throw new Error("the send call returned no message id");
  mark(options, "accepted");
  log("send_accepted", { purpose, loadId, messageId, channel: "whatsapp" });
  try {
    noteRecorded(options, await recordSend(messageId, loadId, purpose, "whatsapp", shown, audience));
  } catch (error) {
    // The document is out; a lost receipt row must not turn into a second send.
    log("send_record_failed", { purpose, loadId, messageId, error: (error as Error).name });
  }
  return messageId;
}

// Sends one RCS message through the same gates. RCS reaches phone numbers only. The load and
// purpose ride along as Context, so delivery events name their load even before the record exists.
export async function sendRcs(target: Target, content: RcsMessageContent, purpose: string, loadId: string, options: SendOptions = {}): Promise<string | null> {
  const rcs = env.rcs();
  if (!rcs) throw new SendNotStarted("RCS is not configured (RCS_AGENT_ID, RCS_TOPIC_ARN)", NOT_SENT.rcsOff, true);
  const gate = await cleared(target, purpose, loadId, options);
  if ("blocked" in gate) {
    noteRecorded(options, (await recordBlocked(loadId, purpose, "rcs", renderRcs(content), options.audience ?? "driver", gate.blocked)) !== null);
    return null;
  }
  const address = gate.address;
  if (address.kind !== "phone") throw new SendNotStarted("RCS needs a phone number", NOT_SENT.rcsNeedsPhone, true);
  const configurationSet = env.rcsConfigurationSet();
  mark(options, "sending");
  const out = await sms.send(
    new SendRcsMessageCommand({
      DestinationPhoneNumber: address.e164,
      OriginationIdentity: rcs.agentId,
      RcsMessageContent: content,
      ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
      Context: { loadId, purpose },
    }),
  );
  const messageId = out.MessageId ?? null;
  if (messageId) mark(options, "accepted");
  log("send_accepted", { purpose, loadId, messageId, channel: "rcs" });
  if (messageId) noteRecorded(options, await recordSend(messageId, loadId, purpose, "rcs", renderRcs(content), options.audience ?? "driver"));
  return messageId;
}

// The dispatch prompt on the load's channel: the approved template on WhatsApp, a card on RCS.
export async function sendDispatchPrompt(
  target: Target,
  channel: Channel,
  language: Language,
  loadId: string,
  nonce: string,
  facility: string,
  appointment: string,
): Promise<string | null> {
  return channel === "rcs"
    ? sendRcs(target, rcsDispatchCard(language, loadId, nonce, facility, appointment), "dispatch_card", loadId)
    : send(target, dispatchTemplate(language, loadId, nonce, facility, appointment), "dispatch_template", loadId);
}
