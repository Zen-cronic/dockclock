import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { notifyDispatch, type EscalationPack } from "./escalate.js";
import { ddb, getLoad } from "./store.js";
import { env } from "./config.js";
import { keys } from "./keys.js";

// Step Functions calls this whenever a sealed load needs a person: NEEDS_HUMAN, an approval that
// timed out, or a claim the agent did not file.
export async function handler(input: { loadId: string; reason?: string }): Promise<{ notified: boolean }> {
  const load = await getLoad(input.loadId);
  if (!load?.sealedPackId) return { notified: false };
  const pack = (await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.pack(load.loadId, load.sealedPackId) }))).Item as EscalationPack | undefined;
  await notifyDispatch(load, input.reason ?? "needs a person", { pack: { ...(pack?.confidence ? { confidence: pack.confidence } : {}), ...(pack?.amountUsd !== undefined ? { amountUsd: pack.amountUsd } : {}), ...(pack?.reasons ? { reasons: pack.reasons } : {}) } });
  return { notified: true };
}
