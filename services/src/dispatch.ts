import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { clauseById } from "@dockclock/clause-engine";
import { facilityById, type Channel } from "@dockclock/evidence";
import { ddb, type Address } from "./store.js";
import { driverKey } from "./identity.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const sfn = new SFNClient({});

export interface DispatchInput {
  loadId: string;
  clauseId: string;
  facilityId: string;
  appointmentAt: string;
  channel: Channel;
  address: Address;
}

// Creates the load, binds the driver to it, and starts its lifecycle workflow. Sending the dispatch
// template is the next packet; this is the state the template's buttons act on.
export async function handler(input: DispatchInput): Promise<{ loadId: string; executionArn: string }> {
  clauseById(input.clauseId);
  facilityById(input.facilityId);
  const key = await driverKey(input.address.kind === "bsuid" ? { kind: "bsuid", id: input.address.id } : { kind: "phone", e164: input.address.e164 });
  await ddb.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: env.table(),
            Item: {
              ...keys.load(input.loadId),
              loadId: input.loadId,
              clauseId: input.clauseId,
              facilityId: input.facilityId,
              appointmentAt: input.appointmentAt,
              channel: input.channel,
              address: input.address,
              driverKey: key,
              phase: "dispatched",
              version: 1,
              arrived: null,
              released: null,
              tokens: {},
              createdAt: new Date().toISOString(),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        { Put: { TableName: env.table(), Item: { ...keys.driver(key), loadId: input.loadId, address: input.address } } },
      ],
    }),
  );
  const execution = await sfn.send(
    new StartExecutionCommand({ stateMachineArn: env.stateMachineArn(), name: `${input.loadId}-${Date.now()}`, input: JSON.stringify({ loadId: input.loadId }) }),
  );
  if (!execution.executionArn) throw new Error("StartExecution returned no ARN");
  await ddb.send(
    new UpdateCommand({ TableName: env.table(), Key: keys.load(input.loadId), UpdateExpression: "SET executionArn = :e", ExpressionAttributeValues: { ":e": execution.executionArn } }),
  );
  log("load_dispatched", { loadId: input.loadId, clauseId: input.clauseId, facilityId: input.facilityId, channel: input.channel });
  return { loadId: input.loadId, executionArn: execution.executionArn };
}
