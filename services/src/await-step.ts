import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Step } from "./lifecycle.js";
import { reconcile } from "./tokens.js";
import { ddb } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

export interface AwaitInput {
  loadId: string;
  step: Step;
  token: string;
}

// Called by Step Functions with a task token. Parks the token on the load, then resumes at once if
// the driver already completed the step before the workflow reached it.
export async function handler(input: AwaitInput): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.load(input.loadId),
      UpdateExpression: "SET tokens.#s = :t",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#s": input.step },
      ExpressionAttributeValues: { ":t": input.token },
    }),
  );
  log("step_waiting", { loadId: input.loadId, step: input.step });
  await reconcile(input.loadId);
}
