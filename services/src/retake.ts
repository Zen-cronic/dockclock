import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { MAX_FLOW_SENDS, RETAKE_WAIT_SECONDS, type Effect } from "./lifecycle.js";
import { drainOutbox } from "./ingest.js";
import { ddb, getLoad, type LoadItem, type OutboxEntry } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

// Step Functions calls this once when the agent's reading says the photo is unreadable. The load
// goes back to waiting for the bill of lading, and the driver gets the camera Flow again with a
// short reason. The unreadable photo stays on the load until a new one replaces it, so a driver who
// does not answer still seals with the original.
// The wait the workflow needs for a request already made: what is left of it, at least a minute.
async function resumeExisting(load: LoadItem): Promise<{ requested: boolean; waitSeconds: number }> {
  await drainOutbox(load.loadId);
  const left = load.retakeUntil ? Math.ceil((Date.parse(load.retakeUntil) - Date.now()) / 1000) : 0;
  log("retake_resumed", { loadId: load.loadId, secondsLeft: left });
  return { requested: true, waitSeconds: Math.max(60, left) };
}

export { RETAKE_WAIT_SECONDS };

export async function handler(input: { loadId: string }): Promise<{ requested: boolean; waitSeconds: number }> {
  const load = await getLoad(input.loadId);
  const waitSeconds = load?.demo ? RETAKE_WAIT_SECONDS.demo : RETAKE_WAIT_SECONDS.standard;
  // A retried step whose first run already asked: report the request it made, with the time left,
  // so the workflow still waits instead of sealing at once.
  if (load?.retakeOf) return resumeExisting(load);
  if (!load?.bol || load.phase !== "documented") return { requested: false, waitSeconds };
  if ((load.flowSends ?? 0) >= MAX_FLOW_SENDS) {
    log("retake_skipped", { loadId: load.loadId, reason: "Flow re-send limit reached" });
    return { requested: false, waitSeconds };
  }
  const now = new Date().toISOString();
  const until = new Date(Date.now() + waitSeconds * 1000).toISOString();
  const entries: Array<[string, Effect]> = [
    [`${now}#retake#1`, { type: "ask_retake" }],
    [`${now}#retake#2`, { type: "send_release_flow" }],
  ];
  const names = Object.fromEntries(entries.map(([seq], i) => [`#k${i}`, seq]));
  const values = Object.fromEntries(entries.map(([seq, effect], i) => [`:o${i}`, { seq, effect } satisfies OutboxEntry]));
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.load(load.loadId),
        UpdateExpression: `SET phase = :w, retakeOf = :m, retakeRequestedAt = :t, retakeUntil = :u, flowSends = if_not_exists(flowSends, :zero) + :one, version = version + :one, ${entries.map((_, i) => `outbox.#k${i} = :o${i}`).join(", ")}`,
        ConditionExpression: "phase = :d AND attribute_not_exists(retakeOf)",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ":w": "awaiting_bol", ":d": "documented", ":m": load.bol.messageId, ":t": now, ":u": until, ":zero": 0, ":one": 1, ...values },
      }),
    );
  } catch (error) {
    if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
    // A concurrent run asked first: answer as that run did.
    const now = await getLoad(load.loadId);
    if (now?.retakeOf) return resumeExisting(now);
    return { requested: false, waitSeconds };
  }
  log("retake_requested", { loadId: load.loadId, unreadable: load.bol.messageId });
  await drainOutbox(load.loadId);
  return { requested: true, waitSeconds };
}
