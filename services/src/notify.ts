import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { notifyDispatch } from "./escalate.js";
import { ddb, getLoad } from "./store.js";
import { env } from "./config.js";
import { keys } from "./keys.js";

// Step Functions calls this whenever a sealed load needs a person: NEEDS_HUMAN, an approval that
// timed out, or a claim the agent did not file.
export async function handler(input: { loadId: string; reason?: string }): Promise<{ notified: boolean }> {
  const load = await getLoad(input.loadId);
  if (!load?.sealedPackId) return { notified: false };
  const pack = (await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.pack(load.loadId, load.sealedPackId) }))).Item as { confidence?: string } | undefined;
  await notifyDispatch(load, `${input.reason ?? "needs a person"}; evidence confidence ${pack?.confidence ?? "unknown"}`);
  return { notified: true };
}
