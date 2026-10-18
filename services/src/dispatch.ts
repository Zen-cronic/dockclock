import { randomBytes } from "node:crypto";
import { SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { clauseById } from "@dockclock/clause-engine";
import { facilityById, type Channel } from "@dockclock/evidence";
import { LOAD_ID_PATTERN } from "@dockclock/whatsapp";
import { isTerminal } from "./lifecycle.js";
import { ddb, getDriver, getLoad, type Address } from "./store.js";
import { driverKey } from "./identity.js";
import { COPY, LANGUAGES, type Language } from "./messages.js";
import { canonical, dispatchTemplate, isOptedOut, send } from "./sender.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const sfn = new SFNClient({ maxAttempts: 3 });
// The arrival wait runs until this long after the appointment, however far ahead it was booked.
const ARRIVAL_GRACE_SECONDS = 2 * 86_400;
const EXPLICIT_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

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
  // Re-send the dispatch template (and start the workflow if it never started) for an open load.
  resend?: boolean;
  // Test loads: escalations are logged, never emailed to dispatch.
  synthetic?: boolean;
}

export interface DispatchOutput {
  loadId: string;
  executionArn: string;
  templateMessageId: string | null;
  dispatchError: string | null;
  superseded: string | null;
}

export class DispatchRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchRejected";
  }
}

function formatAppointment(iso: string, timeZone: string, language: Language): string {
  return new Intl.DateTimeFormat(COPY[language].locale, { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

// Every input is checked before anything is stored, so a rejected dispatch leaves nothing behind.
export function validate(input: DispatchInput): { language: Language; address: Address; appointment: string } {
  if (!LOAD_ID_PATTERN.test(input.loadId)) throw new DispatchRejected("loadId must be 1-40 letters, digits or dashes");
  if (!EXPLICIT_OFFSET.test(input.appointmentAt) || Number.isNaN(Date.parse(input.appointmentAt))) {
    throw new DispatchRejected("appointmentAt must be an ISO time with an explicit offset, e.g. 2026-10-17T14:00:00-04:00");
  }
  clauseById(input.clauseId);
  const facility = facilityById(input.facilityId);
  const language = input.language ?? "en_US";
  if (!LANGUAGES.includes(language)) throw new DispatchRejected(`unsupported language ${language}`);
  if (!input.optIn?.method || Number.isNaN(Date.parse(input.optIn.at))) throw new DispatchRejected("driver opt-in (method, at) is required before any message");
  let address: Address;
  try {
    address = canonical(input.address);
  } catch {
    throw new DispatchRejected("address.e164 is not a valid phone number");
  }
  return { language, address, appointment: formatAppointment(input.appointmentAt, facility.timeZone, language) };
}

function arrivalTimeoutSeconds(appointmentAt: string): number {
  return Math.max(0, Math.ceil((Date.parse(appointmentAt) - Date.now()) / 1000)) + ARRIVAL_GRACE_SECONDS;
}

async function startWorkflow(loadId: string, appointmentAt: string): Promise<string> {
  const execution = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: env.stateMachineArn(),
      name: `${loadId}-${Date.now()}`,
      input: JSON.stringify({ loadId, arrivalTimeoutSeconds: arrivalTimeoutSeconds(appointmentAt) }),
    }),
  );
  if (!execution.executionArn) throw new Error("StartExecution returned no ARN");
  await ddb.send(new UpdateCommand({ TableName: env.table(), Key: keys.load(loadId), UpdateExpression: "SET executionArn = :e", ExpressionAttributeValues: { ":e": execution.executionArn } }));
  return execution.executionArn;
}

// One live load per driver: dispatching a new one closes the previous open load, so its old
// buttons answer "closed" and its pins cannot land on the new load.
async function supersede(previousLoadId: string, byLoadId: string): Promise<string | null> {
  const previous = await getLoad(previousLoadId);
  if (!previous || previous.loadId === byLoadId || isTerminal(previous.phase)) return null;
  await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.load(previousLoadId),
      UpdateExpression: "SET phase = :c, outcome = :o, supersededBy = :b",
      ConditionExpression: "NOT phase IN (:sealed, :c)",
      ExpressionAttributeValues: { ":c": "closed", ":o": "SUPERSEDED", ":b": byLoadId, ":sealed": "sealed" },
    }),
  ).catch((error: Error) => {
    if (error.name !== "ConditionalCheckFailedException") throw error;
  });
  if (previous.executionArn) {
    await sfn.send(new StopExecutionCommand({ executionArn: previous.executionArn, cause: `Superseded by load ${byLoadId}` })).catch(() => undefined);
  }
  log("load_superseded", { loadId: previousLoadId, by: byLoadId });
  return previousLoadId;
}

async function sendTemplate(loadId: string, target: { address: Address; driverKey: string }, language: Language, nonce: string, facility: string, appointment: string) {
  try {
    const id = await send(target, dispatchTemplate(language, loadId, nonce, facility, appointment), "dispatch_template", loadId);
    await ddb.send(
      new UpdateCommand({ TableName: env.table(), Key: keys.load(loadId), UpdateExpression: "SET dispatchMessageId = :m REMOVE dispatchError", ExpressionAttributeValues: { ":m": id } }),
    );
    return { templateMessageId: id, dispatchError: null };
  } catch (error) {
    const dispatchError = `${(error as Error).name}: ${(error as Error).message}`;
    await ddb.send(new UpdateCommand({ TableName: env.table(), Key: keys.load(loadId), UpdateExpression: "SET dispatchError = :x", ExpressionAttributeValues: { ":x": dispatchError } }));
    return { templateMessageId: null, dispatchError };
  }
}

// Creates the load, binds the driver to it, starts its lifecycle workflow and sends the dispatch
// template whose Arrived button opens the driver's 24-hour window. A failed template send is
// reported, not thrown: the load stays open and `resend: true` retries it.
export async function handler(input: DispatchInput): Promise<DispatchOutput> {
  const { language, address, appointment } = validate(input);
  const facility = facilityById(input.facilityId);
  const key = await driverKey(address.kind === "bsuid" ? { kind: "bsuid", id: address.id, e164: null } : { kind: "phone", e164: address.e164 });
  if (await isOptedOut(key)) throw new DispatchRejected("driver has opted out of load messages (replied STOP)");
  const target = { address, driverKey: key };

  if (input.resend) {
    const load = await getLoad(input.loadId);
    if (!load || isTerminal(load.phase) || load.phase !== "dispatched") throw new DispatchRejected("resend needs an open load that has not started");
    const executionArn = load.executionArn ?? (await startWorkflow(load.loadId, load.appointmentAt));
    const sent = await sendTemplate(load.loadId, { address: load.address, driverKey: load.driverKey }, load.language, load.nonce, facility.name, appointment);
    log("load_redispatched", { loadId: load.loadId, dispatchError: sent.dispatchError });
    return { loadId: load.loadId, executionArn, ...sent, superseded: null };
  }

  const existing = await getDriver(key);
  const nonce = randomBytes(6).toString("hex");
  const createdAt = new Date().toISOString();
  const driverItem = { loadId: input.loadId, address, optIn: input.optIn, language, dispatchedAt: createdAt, boundBsuid: existing?.boundBsuid };
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
              address,
              driverKey: key,
              nonce,
              phase: "dispatched",
              version: 1,
              arrived: null,
              released: null,
              bol: null,
              flowSends: 0,
              tokens: {},
              outbox: {},
              synthetic: input.synthetic === true,
              createdAt,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        { Put: { TableName: env.table(), Item: { ...keys.driver(key), ...driverItem } } },
        // A BSUID already bound to this driver follows the new load too.
        ...(existing?.boundBsuid
          ? [{ Put: { TableName: env.table(), Item: { ...keys.driver(existing.boundBsuid), ...driverItem, boundBsuid: undefined, boundFrom: key } } }]
          : []),
      ],
    }),
  );
  const superseded = existing ? await supersede(existing.loadId, input.loadId) : null;
  const executionArn = await startWorkflow(input.loadId, input.appointmentAt);
  const sent = await sendTemplate(input.loadId, target, language, nonce, facility.name, appointment);
  log("load_dispatched", { loadId: input.loadId, clauseId: input.clauseId, facilityId: input.facilityId, channel: input.channel, language, superseded, dispatchError: sent.dispatchError });
  return { loadId: input.loadId, executionArn, ...sent, superseded };
}
