import { randomBytes } from "node:crypto";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { encodeButtonPayload, type ButtonPayload, type InboundEvent } from "@dockclock/whatsapp";
import { ddb, getLoad } from "./store.js";
import { driverKey } from "./identity.js";
import { send, textMessage } from "./sender.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const sfn = new SFNClient({ maxAttempts: 3 });
export const TEMPLATE_APPROVAL = "dockclock_dispatch_approval";

interface PackItem {
  verdict: string;
  confidence: string;
}

interface ApprovalRequest {
  token: string;
  nonce: string;
  requestedAt: string;
  decidedAt?: string;
}

export function approvalTemplate(loadId: string, nonce: string, summary: string, amount: string): Record<string, unknown> {
  const quickReply = (index: number, action: "approve" | "hold") => ({
    type: "button",
    sub_type: "quick_reply",
    index: String(index),
    parameters: [{ type: "payload", payload: encodeButtonPayload({ action, loadId, nonce }) }],
  });
  return {
    type: "template",
    template: {
      name: TEMPLATE_APPROVAL,
      language: { code: "en_US" },
      components: [{ type: "body", parameters: [loadId, summary, amount].map((text) => ({ type: "text", text })) }, quickReply(0, "approve"), quickReply(1, "hold")],
    },
  };
}

// Step Functions calls this with a task token after a load seals BILLABLE. The dispatcher gets the
// approval template; the workflow waits until they tap Approve or Hold (or the wait times out).
export async function requestApproval(input: { loadId: string; token: string; amountUsd: number }): Promise<void> {
  const load = await getLoad(input.loadId);
  if (!load?.sealedPackId) throw new Error(`load ${input.loadId} is not sealed`);
  // Test loads never page the dispatcher unless the test asked for it; they end as held.
  if (load.synthetic && !load.askDispatcher) {
    await sfn.send(new SendTaskFailureCommand({ taskToken: input.token, error: "HeldByDispatch", cause: "synthetic test load: approval not requested" }));
    log("approval_skipped", { loadId: load.loadId, reason: "synthetic test load" });
    return;
  }
  const pack = (await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.pack(load.loadId, load.sealedPackId) }))).Item as PackItem | undefined;
  const reading = (load as unknown as { bolReading?: { legible: boolean } }).bolReading;
  const photo = reading ? (reading.legible ? "photo readable" : "photo NOT readable") : "no photo reading";
  const summary = `the contract clause is met, evidence confidence ${pack?.confidence ?? "unknown"}, ${photo}`;
  const nonce = randomBytes(6).toString("hex");
  await ddb.send(
    new PutCommand({
      TableName: env.table(),
      Item: { ...keys.approvalRequest(load.loadId), token: input.token, nonce, requestedAt: new Date().toISOString() } satisfies ApprovalRequest & Record<string, unknown>,
    }),
  );
  const target = await dispatcherTarget(env.dispatcherPhone());
  await send(target, approvalTemplate(load.loadId, nonce, summary, `$${input.amountUsd.toFixed(2)}`), "dispatch_approval", load.loadId);
  log("approval_requested", { loadId: load.loadId, confidence: pack?.confidence, photo });
}

async function dispatcherTarget(e164: string) {
  const address = { kind: "phone" as const, e164 };
  return { address, driverKey: await driverKey(address) };
}

export function isApprovalTap(payload: ButtonPayload | null): payload is ButtonPayload & { action: "approve" | "hold" } {
  return payload?.action === "approve" || payload?.action === "hold";
}

// A dispatcher's Approve or Hold tap. Accepted only from the dispatcher's number, with the nonce of
// the open request, and only once; it then resumes the waiting workflow.
export async function handleApprovalTap(event: InboundEvent, payload: ButtonPayload & { action: "approve" | "hold" }): Promise<void> {
  // WhatsApp may report a business-scoped id; the phone number, when present, is what we match.
  const from = event.sender.e164;
  const reply = async (text: string) => {
    if (from) await send(await dispatcherTarget(from), textMessage(text), "approval_reply", payload.loadId);
  };
  if (!from || from !== env.dispatcherPhone()) {
    log("approval_rejected", { loadId: payload.loadId, reason: "not the dispatcher" });
    return;
  }
  const request = (await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.approvalRequest(payload.loadId), ConsistentRead: true }))).Item as ApprovalRequest | undefined;
  if (!request || request.nonce !== payload.nonce) {
    log("approval_rejected", { loadId: payload.loadId, reason: "no open request with this nonce" });
    return;
  }
  if (request.decidedAt) {
    // A second tap (ingest has already dropped redeliveries of the same message): say what stands.
    log("approval_ignored", { loadId: payload.loadId, reason: "already decided" });
    const decided = (request as ApprovalRequest & { decision?: string }).decision === "approve" ? "approved" : "held";
    await reply(`Load ${payload.loadId} was already ${decided}. Nothing changed.`);
    return;
  }
  // Order matters for redelivery: record the decision, resume the workflow (tolerating a token that
  // was already used), and only then close the request, so a crash at any step is retried cleanly.
  const resume = async (command: () => Promise<unknown>) => {
    try {
      await command();
    } catch (error) {
      if (!["TaskDoesNotExist", "TaskTimedOut", "InvalidToken"].includes((error as Error).name)) throw error;
    }
  };
  if (payload.action === "approve") {
    const approvalId = `appr-${randomBytes(6).toString("hex")}`;
    try {
      await ddb.send(
        new PutCommand({
          TableName: env.table(),
          Item: { ...keys.approval(payload.loadId), approvalId, approvedAt: new Date().toISOString(), approver: "dispatcher-whatsapp", approvalMessageId: event.wamid },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (error) {
      // A redelivered tap: the approval already exists and is reused below.
      if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
    }
    const recorded = (await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.approval(payload.loadId), ConsistentRead: true }))).Item as { approvalId: string };
    await resume(() => sfn.send(new SendTaskSuccessCommand({ taskToken: request.token, output: JSON.stringify({ decision: "approve", approvalId: recorded.approvalId }) })));
  } else {
    await resume(() => sfn.send(new SendTaskFailureCommand({ taskToken: request.token, error: "HeldByDispatch", cause: "Dispatcher tapped Hold" })));
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.approvalRequest(payload.loadId),
        UpdateExpression: "SET decidedAt = :t, decision = :d",
        ConditionExpression: "attribute_not_exists(decidedAt)",
        ExpressionAttributeValues: { ":t": new Date().toISOString(), ":d": payload.action },
      }),
    );
  } catch (error) {
    if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
    return;
  }
  await reply(payload.action === "approve" ? `Approved. The claims agent is filing load ${payload.loadId} now.` : `Held. Nothing will be sent for load ${payload.loadId}.`);
  log("approval_decided", { loadId: payload.loadId, decision: payload.action });
}
