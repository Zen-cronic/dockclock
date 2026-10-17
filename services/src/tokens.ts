import { SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { stepSatisfied, type Step } from "./lifecycle.js";
import { ddb, getLoad } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const sfn = new SFNClient({});
const GONE = new Set(["TaskDoesNotExist", "TaskTimedOut", "InvalidToken"]);

// Resumes every Step Functions wait whose condition is already met. Both the ingest path and the
// wait step call this, so whichever runs second wins the race and a redelivery is harmless.
export async function reconcile(loadId: string): Promise<Step[]> {
  const load = await getLoad(loadId);
  if (!load) return [];
  const resumed: Step[] = [];
  for (const step of Object.keys(load.tokens ?? {}) as Step[]) {
    const token = load.tokens[step];
    if (!token || !stepSatisfied(load, step)) continue;
    const at = step === "arrived" ? load.arrived?.serverAt : step === "released" ? load.released?.serverAt : load.bol?.serverAt;
    try {
      await sfn.send(new SendTaskSuccessCommand({ taskToken: token, output: JSON.stringify({ loadId, step, at }) }));
      resumed.push(step);
    } catch (error) {
      if (!GONE.has((error as Error).name)) throw error;
    }
    await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.load(loadId),
        UpdateExpression: "REMOVE tokens.#s",
        ConditionExpression: "tokens.#s = :t",
        ExpressionAttributeNames: { "#s": step },
        ExpressionAttributeValues: { ":t": token },
      }),
    ).catch((error: Error) => {
      if (error.name !== "ConditionalCheckFailedException") throw error;
    });
  }
  if (resumed.length) log("steps_resumed", { loadId, steps: resumed });
  return resumed;
}
