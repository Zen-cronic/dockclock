import { randomBytes } from "node:crypto";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { clauseById } from "@dockclock/clause-engine";
import { facilityById, type Channel } from "@dockclock/evidence";
import { ddb, type Address } from "./store.js";
import { driverKey } from "./identity.js";
import { COPY, LANGUAGES, type Language } from "./messages.js";
import { dispatchTemplate, send } from "./sender.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const sfn = new SFNClient({});

export interface OptIn {
  // How the driver agreed to receive load messages, e.g. the fleet's onboarding form.
  method: string;
  at: string;
}

export interface DispatchInput {
  loadId: string;
  clauseId: string;
  facilityId: string;
  appointmentAt: string;
  channel: Channel;
  address: Address;
  language?: Language;
  optIn: OptIn;
}

export interface DispatchOutput {
  loadId: string;
  executionArn: string;
  templateMessageId: string | null;
}

function formatAppointment(iso: string, timeZone: string, language: Language): string {
  return new Intl.DateTimeFormat(COPY[language].locale, { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

// Creates the load, binds the driver to it, starts its lifecycle workflow and sends the dispatch
// template whose Arrived button opens the driver's 24-hour window. Refuses drivers with no opt-in.
export async function handler(input: DispatchInput): Promise<DispatchOutput> {
  clauseById(input.clauseId);
  const facility = facilityById(input.facilityId);
  const language = input.language ?? "en_US";
  if (!LANGUAGES.includes(language)) throw new Error(`unsupported language ${language}`);
  if (!input.optIn?.method || Number.isNaN(Date.parse(input.optIn.at))) throw new Error("driver opt-in (method, at) is required before any message");
  const key = await driverKey(input.address.kind === "bsuid" ? { kind: "bsuid", id: input.address.id, e164: null } : { kind: "phone", e164: input.address.e164 });
  const nonce = randomBytes(6).toString("hex");
  const createdAt = new Date().toISOString();
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
              language,
              address: input.address,
              driverKey: key,
              nonce,
              phase: "dispatched",
              version: 1,
              arrived: null,
              released: null,
              bol: null,
              tokens: {},
              createdAt,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        { Put: { TableName: env.table(), Item: { ...keys.driver(key), loadId: input.loadId, address: input.address, optIn: input.optIn, language, dispatchedAt: createdAt } } },
      ],
    }),
  );
  const execution = await sfn.send(
    new StartExecutionCommand({ stateMachineArn: env.stateMachineArn(), name: `${input.loadId}-${Date.now()}`, input: JSON.stringify({ loadId: input.loadId }) }),
  );
  if (!execution.executionArn) throw new Error("StartExecution returned no ARN");
  let templateMessageId: string | null = null;
  let dispatchError: string | null = null;
  try {
    templateMessageId = await send(
      input.address,
      dispatchTemplate(input.address, language, input.loadId, nonce, facility.name, formatAppointment(input.appointmentAt, facility.timeZone, language)),
      "dispatch_template",
      input.loadId,
    );
  } catch (error) {
    dispatchError = `${(error as Error).name}: ${(error as Error).message}`;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.load(input.loadId),
      UpdateExpression: "SET executionArn = :e, dispatchMessageId = :m, dispatchError = :x",
      ExpressionAttributeValues: { ":e": execution.executionArn, ":m": templateMessageId, ":x": dispatchError },
    }),
  );
  log("load_dispatched", { loadId: input.loadId, clauseId: input.clauseId, facilityId: input.facilityId, channel: input.channel, language, dispatchError });
  if (dispatchError) throw new Error(`load created but dispatch template failed: ${dispatchError}`);
  return { loadId: input.loadId, executionArn: execution.executionArn, templateMessageId };
}
