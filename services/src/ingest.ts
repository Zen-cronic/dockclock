import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { RcsMessageContent } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { facilityById, isoToLocalClock, zoneAbbreviation } from "@dockclock/evidence";
import { decodeRcsEvent, isFromTopic, type RcsEvent, type RcsStatusEvent } from "@dockclock/rcs";
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
import { applyEvent, failoverEffect, isTerminal, promptPhase, type Effect } from "./lifecycle.js";
import { COPY, formatAppointment, type Language } from "./messages.js";
import { bindPrimary, ddb, getDriver, getLoad, ownsLoad, resolveActiveLoad, setOptOut, toState, type LoadItem, type OutboxEntry } from "./store.js";
import { driverKeys, replyAddress } from "./identity.js";
import { locationRequest, releaseButtons, releaseFlowMessage, send, sendDispatchPrompt, sendRcs, textMessage, type Body, type Target } from "./sender.js";
import { rcsBolRequest, rcsLocationRequest, rcsReleaseOffer, rcsText } from "./rcs.js";
import { notifyDispatch } from "./escalate.js";
import { handleApprovalTap, isApprovalTap } from "./approval.js";
import { demoLanguage, handleDemo } from "./demo.js";
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
                  // The channel this event came in on, which after a failover can differ from the load's.
                  channel: event.channel ?? "whatsapp",
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
  const language: Language = load.language ?? "en_US";
  const clock = (iso: string | undefined) => (iso ? isoToLocalClock(iso, facility.timeZone) : "");
  // What the driver reads: the clock time with its zone ("14:25 EDT").
  const zoned = (iso: string | undefined) => (iso ? `${clock(iso)} ${zoneAbbreviation(iso, facility.timeZone)}` : "");
  const target = targetOf(load);
  // Every prompt goes out on the load's current channel; a failover switches it to RCS.
  const deliver = (purpose: string, whatsapp: () => Body, rcs: () => RcsMessageContent) =>
    load.channel === "rcs" ? sendRcs(target, rcs(), purpose, load.loadId) : send(target, whatsapp(), purpose, load.loadId);
  const tell = (text: string, purpose: string) => deliver(purpose, () => textMessage(text), () => rcsText(text));
  switch (effect.type) {
    case "request_location":
      await deliver(`location_${effect.step}`, () => locationRequest(language, effect.step), () => rcsLocationRequest(language, effect.step));
      return;
    case "offer_release": {
      const at = zoned(load.arrived?.serverAt);
      await deliver(
        "offer_release",
        () => releaseButtons(language, load.loadId, load.nonce, facility.name, at),
        () => rcsReleaseOffer(language, load.loadId, load.nonce, facility.name, at),
      );
      return;
    }
    case "send_release_flow":
      await deliver(
        "release_flow",
        () =>
          releaseFlowMessage(language, load.loadId, load.nonce, facility.name, {
            releasedAt: zoned(load.released?.serverAt),
            loadLabel: `${load.loadId} · ${facility.name}`,
            arrivedHint: clock(load.arrived?.serverAt),
            releasedHint: clock(load.released?.serverAt),
          }),
        () => rcsBolRequest(language, facility.name, zoned(load.released?.serverAt)),
      );
      return;
    case "send_dispatch":
      await sendDispatchPrompt(target, load.channel, language, load.loadId, load.nonce, facility.name, formatAppointment(load.appointmentAt, facility.timeZone, language));
      return;
    case "tell_driver": {
      // An entry queued by an older build may name a key this build no longer has: drop it rather
      // than block the effects queued behind it.
      const text = COPY[language].replies[effect.key] as string | undefined;
      if (!text) {
        log("effect_dropped", { loadId: load.loadId, effect: `tell_${String(effect.key)}`, reason: "unknown message key" });
        return;
      }
      await tell(text, `tell_${effect.key}`);
      return;
    }
    case "ask_retake": {
      // A replay after the deadline, or after the load moved on, would tell the driver a time that
      // has passed: send nothing.
      const left = load.retakeUntil ? Date.parse(load.retakeUntil) - Date.now() : 0;
      if (left <= 0 || load.phase !== "awaiting_bol") {
        log("effect_dropped", { loadId: load.loadId, effect: "ask_retake", reason: left <= 0 ? "retake deadline passed" : `phase ${load.phase}` });
        return;
      }
      const until = load.retakeUntil!;
      await tell(COPY[language].retakeAsk(Math.ceil(left / 60_000), clock(until), zoneAbbreviation(until, facility.timeZone), load.demo === true), "ask_retake");
      return;
    }
    case "escalate":
      await notifyDispatch(load, effect.reason, { unreachable: effect.unreachable === true });
      return;
    case "download_media": {
      const bol = await finishBol(load.loadId);
      const partial = bol?.media === "unavailable";
      // An RCS photo carries no times, so the driver is told only what was actually saved.
      const key = partial ? "bol_partial" : bol?.channel === "rcs" ? "bol_photo_received" : "bol_received";
      await tell(COPY[language].replies[key], `tell_${key}`);
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
    const phase = promptPhase(entry.effect);
    if (phase && phase !== load.phase) log("effect_dropped", { loadId, effect: entry.effect.type, reason: `load is ${load.phase}, prompt was for ${phase}` });
    else await runEffect(load, entry.effect);
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

// STOP and START are honoured for every key the driver is known by, before any load routing.
async function handleOptOut(event: InboundEvent, candidateKeys: string[]): Promise<boolean> {
  if (event.body.type !== "text") return false;
  const stop = STOP_WORDS.test(event.body.text);
  if (!stop && !START_WORDS.test(event.body.text)) return false;
  const records = await Promise.all(candidateKeys.map((k) => getDriver(k)));
  const allKeys = [...new Set([...candidateKeys, ...records.flatMap((r) => (r?.boundFrom ? [r.boundFrom] : []))])];
  await setOptOut(allKeys, stop);
  // On RCS, End User Messaging manages STOP and START itself (the agent's opt-out list and keyword
  // replies), so DockClock records the choice but sends no reply of its own.
  if (event.channel === "rcs") {
    log(stop ? "driver_opted_out" : "driver_opted_in", { keys: allKeys.length, channel: "rcs" });
    return true;
  }
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
  // DEMO starts the judge try-it path, whatever load the sender may have open.
  const demo = demoLanguage(event);
  if (demo) {
    await handleDemo(event, demo, candidateKeys);
    return;
  }
  // Approve and Hold come from the dispatcher, not the driver, and act on sealed loads.
  const tap = event.body.type === "button" ? parseButtonPayload(event.body.payload) : null;
  if (isApprovalTap(tap)) {
    await handleApprovalTap(event, tap, candidateKeys);
    return;
  }
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
async function onStatus(event: StatusEvent | RcsStatusEvent): Promise<void> {
  const id = event.eumMessageId ?? event.wamid;
  const failed = event.state === "failed";
  const sets = ["#s = if_not_exists(#s, :at)", "wamid = :w"];
  const values: Record<string, unknown> = { ":at": event.serverAt, ":w": event.wamid };
  if (failed) {
    sets.push("errorCode = :e");
    values[":e"] = event.errorCode;
  }
  if ("channel" in event) {
    // RCS receipts name their load from the send's Context, in case they beat our send record.
    sets.push("channel = if_not_exists(channel, :c)");
    values[":c"] = event.channel;
    const add = (expression: string, name: string, value: string | null) => {
      if (!value) return;
      sets.push(expression);
      values[name] = value;
    };
    add("loadId = if_not_exists(loadId, :l)", ":l", event.loadId);
    add("purpose = if_not_exists(purpose, :p)", ":p", event.purpose);
    if (failed) add("failureDescription = :d", ":d", event.description?.slice(0, 300) ?? null);
  }
  const out = await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.receipt(id),
      UpdateExpression: `SET ${sets.join(", ")}`,
      ExpressionAttributeNames: { "#s": `${event.state}At` },
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW",
    }),
  );
  log("receipt_recorded", { messageId: id, state: event.state, errorCode: event.errorCode, channel: "channel" in event ? event.channel : "whatsapp" });
  if (failed) await failover(id, out.Attributes ?? {}, event);
}

// A failed WhatsApp message is re-sent once over RCS and the load stays on RCS from then on; a
// failed RCS message (or a driver RCS cannot reach) goes to dispatch. The conditional write on the
// receipt makes this once per failed message, however many failure events arrive, and the re-send
// rides the load's outbox, so it is retried like any other effect until it has gone out.
async function failover(messageId: string, receipt: Record<string, unknown>, event: StatusEvent): Promise<void> {
  const loadId = typeof receipt.loadId === "string" ? receipt.loadId : null;
  const purpose = typeof receipt.purpose === "string" ? receipt.purpose : "";
  if (!loadId || loadId === "-") {
    log("failover_skipped", { messageId, reason: "not a load message" });
    return;
  }
  if (receipt.failoverAt) {
    // Already queued once. A redelivery still drains, so a re-send that failed is retried; the
    // guard stops a second enqueue, never the delivery.
    log("failover_skipped", { messageId, loadId, reason: "already handled" });
    const drained = await drainOutbox(loadId);
    if (drained) log("outbox_drained", { loadId, effects: drained });
    return;
  }
  const load = await getLoad(loadId);
  if (!load || isTerminal(load.phase)) {
    log("failover_skipped", { messageId, loadId, reason: load ? "load closed" : "load missing" });
    return;
  }
  const from = receipt.channel === "rcs" ? "rcs" : "whatsapp";
  const toRcs = from === "whatsapp" && env.rcs() !== null && load.address.kind === "phone";
  const effect: Effect | null = toRcs
    ? failoverEffect(purpose, load.phase)
    : { type: "escalate", unreachable: true, reason: from === "rcs" ? `RCS delivery failed (${purpose})` : `WhatsApp delivery failed and RCS cannot reach this driver (${purpose})` };
  const action = toRcs ? (effect ? "RESENT_OVER_RCS" : "SWITCHED_TO_RCS") : "ESCALATED_UNREACHABLE";
  const now = new Date().toISOString();
  const seq = `${event.serverAt}#failover#${messageId}`;
  const sets = [...(toRcs ? ["channel = :rcs"] : []), "failedOverAt = if_not_exists(failedOverAt, :now)", ...(effect ? ["outbox.#k = :o"] : [])];
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: env.table(),
              Key: keys.receipt(messageId),
              UpdateExpression: "SET failoverAt = :now, failoverAction = :a",
              ConditionExpression: "attribute_not_exists(failoverAt)",
              ExpressionAttributeValues: { ":now": now, ":a": action },
            },
          },
          {
            Update: {
              TableName: env.table(),
              Key: keys.load(loadId),
              UpdateExpression: `SET ${sets.join(", ")}`,
              ConditionExpression: "attribute_exists(pk)",
              ...(effect ? { ExpressionAttributeNames: { "#k": seq } } : {}),
              ExpressionAttributeValues: { ":now": now, ...(toRcs ? { ":rcs": "rcs" } : {}), ...(effect ? { ":o": { seq, effect } satisfies OutboxEntry } : {}) },
            },
          },
          {
            Put: {
              TableName: env.table(),
              Item: {
                ...keys.event(loadId, event.serverAt, `failover.${messageId}`),
                type: "failover",
                outcome: action,
                phaseBefore: load.phase,
                phaseAfter: load.phase,
                channel: toRcs ? "rcs" : load.channel,
                serverAt: event.serverAt,
                messageId,
                detail: { failedMessageId: messageId, from, purpose, errorCode: event.errorCode, queued: effect?.type ?? null },
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (error instanceof TransactionCanceledException && error.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed") {
      log("failover_skipped", { messageId, loadId, reason: "already handled" });
      const drained = await drainOutbox(loadId);
      if (drained) log("outbox_drained", { loadId, effects: drained });
      return;
    }
    throw error;
  }
  log("failover", { loadId, messageId, from, purpose, action, queued: effect?.type ?? null });
  const drained = await drainOutbox(loadId);
  if (drained) log("outbox_drained", { loadId, effects: drained });
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const config = env.channel();
  const rcs = env.rcs();
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  // Both topics feed this queue; the topic ARN picks the decoder, and each decoder checks its own.
  const eventsOf = (body: string): Array<InboundEvent | StatusEvent | RcsEvent> => {
    if (rcs && isFromTopic(body, rcs.topicArn)) return decodeRcsEvent(body, rcs);
    const { entry, eumMessageId } = decodeEvent(body, config);
    return extractEvents(entry, config, eumMessageId);
  };
  for (const record of event.Records) {
    try {
      for (const channelEvent of eventsOf(record.body)) {
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
