import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { facilityById, isoToLocalClock } from "@dockclock/evidence";
import {
  decodeEvent,
  extractEvents,
  parseButtonPayload,
  parseFlowToken,
  parseReleaseFlow,
  UntrustedEventError,
  type InboundEvent,
  type StatusEvent,
} from "@dockclock/whatsapp";
import { applyEvent, type Effect } from "./lifecycle.js";
import { COPY } from "./messages.js";
import { bindPrimary, ddb, getDriver, getLoad, ownsLoad, resolveActiveLoad, setOptOut, toState, type Address, type LoadItem, type OutboxEntry } from "./store.js";
import { driverKeys } from "./identity.js";
import { locationRequest, releaseButtons, releaseFlowMessage, send, textMessage, type Target } from "./sender.js";
import { notifyDispatch } from "./escalate.js";
import { finishBol } from "./media.js";
import { reconcile } from "./tokens.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const DEDUPE_TTL_SECONDS = 14 * 24 * 3600;
const MAX_VERSION_RETRIES = 3;
const STOP_WORDS = /^\s*(stop|arret|arrêt|alto|baja|unsubscribe|cancel)\s*\.?\s*$/i;
const START_WORDS = /^\s*(start|unstop|reprendre|alta)\s*\.?\s*$/i;

type Applied = { status: "applied"; outcome: string; effects: Effect[] } | { status: "duplicate" };

// What the timeline keeps of each event, so an ignored pin or a stray photo can still be found.
function detailOf(event: InboundEvent): Record<string, unknown> {
  const body = event.body;
  switch (body.type) {
    case "location":
      return { lat: body.lat, lon: body.lon };
    case "image":
    case "audio":
      return { mediaId: body.mediaId, mimeType: body.mimeType };
    case "text":
      return { text: body.text.slice(0, 500) };
    case "button":
      return { payload: body.payload };
    case "flow":
      return { flowToken: parseReleaseFlow(body.responseJson)?.flowToken ?? null };
    case "other":
      return { rawType: body.rawType };
  }
}

// One transaction per event: claim the WhatsApp message id, append to the load's timeline, move
// the load only if nobody else moved it first, and enqueue every side effect in the load's outbox.
// A redelivered event fails the claim and changes nothing; a failed send stays in the outbox.
async function applyOnce(loadId: string, event: InboundEvent): Promise<Applied> {
  for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
    const load = await getLoad(loadId);
    if (!load) throw new Error(`load ${loadId} missing`);
    const transition = applyEvent(toState(load), event);
    const changed = transition.state.version !== load.version;
    const queued = transition.effects.filter((e) => e.type !== "resume");
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ":old": load.version };
    const sets: string[] = [];
    if (changed) {
      const s = transition.state;
      Object.assign(values, { ":p": s.phase, ":v": s.version, ":a": s.arrived, ":r": s.released, ":b": s.bol, ":f": s.flowSends });
      sets.push("phase = :p", "version = :v", "arrived = :a", "released = :r", "bol = :b", "flowSends = :f");
    }
    queued.forEach((effect, i) => {
      const seq = `${event.serverAt}#${event.wamid}#${String(i).padStart(2, "0")}`;
      names[`#o${i}`] = seq;
      values[`:o${i}`] = { seq, effect } satisfies OutboxEntry;
      sets.push(`outbox.#o${i} = :o${i}`);
    });
    const expires = Math.floor(Date.now() / 1000) + DEDUPE_TTL_SECONDS;
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: env.table(), Item: { ...keys.dedupe(event.wamid), loadId, expires }, ConditionExpression: "attribute_not_exists(pk)" } },
            {
              Put: {
                TableName: env.table(),
                Item: {
                  ...keys.event(loadId, event.serverAt, event.wamid),
                  type: event.body.type,
                  outcome: transition.outcome,
                  phaseBefore: load.phase,
                  phaseAfter: transition.state.phase,
                  channel: load.channel,
                  serverAt: event.serverAt,
                  messageId: event.wamid,
                  detail: detailOf(event),
                },
              },
            },
            sets.length > 0
              ? {
                  Update: {
                    TableName: env.table(),
                    Key: keys.load(loadId),
                    UpdateExpression: `SET ${sets.join(", ")}`,
                    ConditionExpression: "version = :old",
                    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
                    ExpressionAttributeValues: values,
                  },
                }
              : { ConditionCheck: { TableName: env.table(), Key: keys.load(loadId), ConditionExpression: "version = :old", ExpressionAttributeValues: { ":old": load.version } } },
          ],
        }),
      );
      return { status: "applied", outcome: transition.outcome, effects: transition.effects };
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;
      const [claim, , version] = error.CancellationReasons ?? [];
      if (claim?.Code === "ConditionalCheckFailed") return { status: "duplicate" };
      if (version?.Code !== "ConditionalCheckFailed") throw error;
    }
  }
  throw new Error(`load ${loadId} kept changing; retry later`);
}

function targetOf(load: LoadItem): Target {
  return { address: load.address, driverKey: load.driverKey };
}

async function runEffect(load: LoadItem, effect: Effect): Promise<void> {
  const facility = facilityById(load.facilityId);
  const language = load.language ?? "en_US";
  const clock = (iso: string | undefined) => (iso ? isoToLocalClock(iso, facility.timeZone) : "");
  const target = targetOf(load);
  switch (effect.type) {
    case "request_location":
      await send(target, locationRequest(language, effect.step), `location_${effect.step}`, load.loadId);
      return;
    case "offer_release":
      await send(target, releaseButtons(language, load.loadId, load.nonce, facility.name, clock(load.arrived?.serverAt)), "offer_release", load.loadId);
      return;
    case "send_release_flow":
      await send(
        target,
        releaseFlowMessage(language, load.loadId, load.nonce, facility.name, {
          loadLabel: `${load.loadId} · ${facility.name}`,
          arrivedHint: clock(load.arrived?.serverAt),
          releasedHint: clock(load.released?.serverAt),
        }),
        "release_flow",
        load.loadId,
      );
      return;
    case "tell_driver":
      await send(target, textMessage(COPY[language].replies[effect.key]), `tell_${effect.key}`, load.loadId);
      return;
    case "escalate":
      await notifyDispatch(load, effect.reason);
      return;
    case "download_media": {
      const bol = await finishBol(load.loadId);
      const partial = bol?.media === "unavailable";
      await send(target, textMessage(COPY[language].replies[partial ? "bol_partial" : "bol_received"]), partial ? "tell_bol_partial" : "tell_bol_received", load.loadId);
      if (partial) await notifyDispatch(load, "some bill-of-lading pages could not be downloaded");
      return;
    }
    case "resume":
      return;
  }
}

// Runs the load's queued side effects in order, removing each only after it succeeds. Called after
// every applied or redelivered event, so a send that failed once is retried on the next delivery.
export async function drainOutbox(loadId: string): Promise<number> {
  const load = await getLoad(loadId);
  const entries = Object.entries(load?.outbox ?? {}).sort(([, a], [, b]) => a.seq.localeCompare(b.seq));
  if (!load || entries.length === 0) return 0;
  for (const [key, entry] of entries) {
    await runEffect(load, entry.effect);
    await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.load(loadId),
        UpdateExpression: "REMOVE outbox.#k",
        ConditionExpression: "attribute_exists(outbox.#k)",
        ExpressionAttributeNames: { "#k": key },
      }),
    ).catch((error: Error) => {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    });
  }
  return entries.length;
}

function namedLoadId(event: InboundEvent): string | null {
  if (event.body.type === "button") return parseButtonPayload(event.body.payload)?.loadId ?? null;
  if (event.body.type === "flow") {
    const response = parseReleaseFlow(event.body.responseJson);
    return response ? (parseFlowToken(response.flowToken)?.loadId ?? null) : null;
  }
  return null;
}

function replyAddress(event: InboundEvent): Address {
  const sender = event.sender;
  if (sender.kind === "phone") return { kind: "phone", e164: sender.e164 };
  return sender.e164 ? { kind: "phone", e164: sender.e164 } : { kind: "bsuid", id: sender.id };
}

// STOP and START are honoured for every key the driver is known by, before any load routing.
async function handleOptOut(event: InboundEvent, candidateKeys: string[]): Promise<boolean> {
  if (event.body.type !== "text") return false;
  const stop = STOP_WORDS.test(event.body.text);
  if (!stop && !START_WORDS.test(event.body.text)) return false;
  const records = await Promise.all(candidateKeys.map((k) => getDriver(k)));
  const allKeys = [...new Set([...candidateKeys, ...records.flatMap((r) => (r?.boundFrom ? [r.boundFrom] : []))])];
  await setOptOut(allKeys, stop);
  const language = records.find((r) => r?.language)?.language ?? "en_US";
  const primary = candidateKeys[0] ?? "";
  await send({ address: replyAddress(event), driverKey: primary }, textMessage(stop ? COPY[language].stopped : COPY[language].resumed), stop ? "opt_out" : "opt_in", "-", {
    ignoreOptOut: true,
  });
  log(stop ? "driver_opted_out" : "driver_opted_in", { keys: allKeys.length });
  return true;
}

async function onInbound(event: InboundEvent): Promise<void> {
  const candidateKeys = await driverKeys(event.sender);
  if (await handleOptOut(event, candidateKeys)) return;
  const named = namedLoadId(event);
  let loadId: string;
  if (named) {
    // Buttons and Flows route by the load they carry, after checking the sender owns it.
    const load = await getLoad(named);
    if (!load || !(await ownsLoad(candidateKeys, load))) {
      log("rejected_unowned_load", { wamid: event.wamid, type: event.body.type, loadExists: load !== null });
      return;
    }
    loadId = named;
    if (await bindPrimary(candidateKeys, load)) log("bsuid_bound", { loadId });
  } else {
    const match = await resolveActiveLoad(candidateKeys);
    if (!match) {
      log("unmatched_sender", { wamid: event.wamid, type: event.body.type, senderKind: event.sender.kind, phoneIncluded: "e164" in event.sender && event.sender.e164 !== null });
      return;
    }
    loadId = match.loadId;
  }
  const result = await applyOnce(loadId, event);
  if (result.status === "duplicate") log("duplicate_event", { loadId, wamid: event.wamid });
  else log("event_applied", { loadId, wamid: event.wamid, type: event.body.type, outcome: result.outcome });
  // Both paths drain: a redelivery is exactly how a failed send gets its second chance.
  const drained = await drainOutbox(loadId);
  if (drained) log("outbox_drained", { loadId, effects: drained });
  await reconcile(loadId);
}

// Delivery receipts for messages we sent, keyed by End User Messaging's message id so they join
// the send record. Each state keeps its first timestamp; order of arrival does not matter.
async function onStatus(event: StatusEvent): Promise<void> {
  const id = event.eumMessageId ?? event.wamid;
  const failed = event.state === "failed";
  await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.receipt(id),
      UpdateExpression: `SET #s = if_not_exists(#s, :at), wamid = :w${failed ? ", errorCode = :e" : ""}`,
      ExpressionAttributeNames: { "#s": `${event.state}At` },
      ExpressionAttributeValues: { ":at": event.serverAt, ":w": event.wamid, ...(failed ? { ":e": event.errorCode } : {}) },
    }),
  );
  log("receipt_recorded", { messageId: id, state: event.state, errorCode: event.errorCode });
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const config = env.channel();
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      const { entry, eumMessageId } = decodeEvent(record.body, config);
      for (const channelEvent of extractEvents(entry, config, eumMessageId)) {
        if (channelEvent.kind === "inbound") await onInbound(channelEvent);
        else await onStatus(channelEvent);
      }
    } catch (error) {
      // Untrusted or unparseable bodies can never succeed; drop them instead of retrying to the DLQ.
      if (error instanceof UntrustedEventError || error instanceof SyntaxError) {
        log("untrusted_event_dropped", { code: error instanceof UntrustedEventError ? error.code : "MALFORMED_JSON", sqsMessageId: record.messageId });
        continue;
      }
      log("record_failed", { sqsMessageId: record.messageId, error: (error as Error).name, message: (error as Error).message });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
