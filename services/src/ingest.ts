import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { facilityById, isoToLocalClock } from "@dockclock/evidence";
import { decodeEvent, extractEvents, UntrustedEventError, type InboundEvent, type StatusEvent } from "@dockclock/whatsapp";
import { applyEvent, type Effect } from "./lifecycle.js";
import { COPY } from "./messages.js";
import { ddb, getActiveLoadId, getLoad, toState, type LoadItem } from "./store.js";
import { driverKey } from "./identity.js";
import { locationRequest, releaseButtons, releaseFlowMessage, send, textMessage } from "./sender.js";
import { finishBol } from "./media.js";
import { reconcile } from "./tokens.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const DEDUPE_TTL_SECONDS = 14 * 24 * 3600;
const MAX_VERSION_RETRIES = 3;

type Applied = { status: "applied"; load: LoadItem; outcome: string; effects: Effect[] } | { status: "duplicate" };

// One transaction per event: claim the WhatsApp message id, append to the load's timeline, and move
// the load only if nobody else moved it first. A redelivered event fails the claim and changes nothing.
async function applyOnce(loadId: string, event: InboundEvent): Promise<Applied> {
  for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
    const load = await getLoad(loadId);
    if (!load) throw new Error(`load ${loadId} missing`);
    const transition = applyEvent(toState(load), event);
    const changed = transition.state.version !== load.version;
    const expires = Math.floor(Date.now() / 1000) + DEDUPE_TTL_SECONDS;
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: env.table(),
                Item: { ...keys.dedupe(event.wamid), loadId, expires },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
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
                },
              },
            },
            changed
              ? {
                  Update: {
                    TableName: env.table(),
                    Key: keys.load(loadId),
                    UpdateExpression: "SET phase = :p, version = :v, arrived = :a, released = :r, bol = :b",
                    ConditionExpression: "version = :old",
                    ExpressionAttributeValues: {
                      ":p": transition.state.phase,
                      ":v": transition.state.version,
                      ":a": transition.state.arrived,
                      ":r": transition.state.released,
                      ":b": transition.state.bol,
                      ":old": load.version,
                    },
                  },
                }
              : {
                  ConditionCheck: {
                    TableName: env.table(),
                    Key: keys.load(loadId),
                    ConditionExpression: "version = :old",
                    ExpressionAttributeValues: { ":old": load.version },
                  },
                },
          ],
        }),
      );
      return { status: "applied", load: { ...load, ...transition.state }, outcome: transition.outcome, effects: transition.effects };
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;
      const [claim, , version] = error.CancellationReasons ?? [];
      if (claim?.Code === "ConditionalCheckFailed") return { status: "duplicate" };
      if (version?.Code !== "ConditionalCheckFailed") throw error;
    }
  }
  throw new Error(`load ${loadId} kept changing; retry later`);
}

async function runEffects(load: LoadItem, effects: Effect[]): Promise<void> {
  const facility = facilityById(load.facilityId);
  const language = load.language ?? "en_US";
  const clock = (iso: string | undefined) => (iso ? isoToLocalClock(iso, facility.timeZone) : "");
  for (const effect of effects) {
    switch (effect.type) {
      case "request_location":
        await send(load.address, locationRequest(load.address, language, effect.step), `location_${effect.step}`, load.loadId);
        break;
      case "offer_release":
        await send(load.address, releaseButtons(load.address, language, load.loadId, load.nonce, facility.name, clock(load.arrived?.serverAt)), "offer_release", load.loadId);
        break;
      case "send_release_flow":
        await send(
          load.address,
          releaseFlowMessage(load.address, language, load.loadId, load.nonce, facility.name, {
            loadLabel: `${load.loadId} · ${facility.name}`,
            arrivedHint: clock(load.arrived?.serverAt),
            releasedHint: clock(load.released?.serverAt),
          }),
          "release_flow",
          load.loadId,
        );
        break;
      case "tell_driver":
        await send(load.address, textMessage(load.address, COPY[language].replies[effect.key]), `tell_${effect.key}`, load.loadId);
        break;
      case "escalate":
        // Dispatcher notification arrives with the dispatcher channel; the timeline already records it.
        log("escalation_requested", { loadId: load.loadId, phase: load.phase });
        break;
      case "download_media":
        await finishBol(load.loadId);
        break;
      case "resume":
        break;
    }
  }
  if (effects.some((e) => e.type === "resume")) await reconcile(load.loadId);
}

async function onInbound(event: InboundEvent): Promise<void> {
  const key = await driverKey(event.sender);
  const loadId = await getActiveLoadId(key);
  if (!loadId) {
    log("unmatched_sender", { wamid: event.wamid, type: event.body.type, senderKind: event.sender.kind });
    return;
  }
  const result = await applyOnce(loadId, event);
  if (result.status === "duplicate") {
    log("duplicate_event", { loadId, wamid: event.wamid });
    // A crash after commit may have skipped the follow-up work; both calls are idempotent.
    await finishBol(loadId);
    await reconcile(loadId);
    return;
  }
  log("event_applied", { loadId, wamid: event.wamid, type: event.body.type, outcome: result.outcome, phase: result.load.phase });
  await runEffects(result.load, result.effects);
}

// Delivery receipts for messages we sent, keyed by End User Messaging's message id so they join
// the send record (load and purpose). Kept as evidence that a message reached the person.
async function onStatus(event: StatusEvent): Promise<void> {
  const id = event.eumMessageId ?? event.wamid;
  await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.receipt(id),
      UpdateExpression: "SET #s = if_not_exists(#s, :at), lastState = :st, errorCode = :e, wamid = :w",
      ExpressionAttributeNames: { "#s": `${event.state}At` },
      ExpressionAttributeValues: { ":at": event.serverAt, ":st": event.state, ":e": event.errorCode, ":w": event.wamid },
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
      if (error instanceof UntrustedEventError) {
        log("untrusted_event_dropped", { code: error.code, sqsMessageId: record.messageId });
        continue;
      }
      log("record_failed", { sqsMessageId: record.messageId, error: (error as Error).name, message: (error as Error).message });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
