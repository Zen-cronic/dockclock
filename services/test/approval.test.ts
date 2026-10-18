import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendTaskFailureCommand, SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { encodeButtonPayload, parseButtonPayload, type InboundEvent } from "@dockclock/whatsapp";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvalTemplate, handleApprovalTap, isApprovalTap, requestApproval } from "../src/approval.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const sfn = mockClient(SFNClient);
const messaging = mockClient(SocialMessagingClient);
const secrets = mockClient(SecretsManagerClient);
const DISPATCHER = "+15550100009";

let request: Record<string, unknown> | undefined;
let approval: Record<string, unknown> | undefined;

function tap(action: "approve" | "hold", nonce = "nonce01", e164: string | null = DISPATCHER): [InboundEvent, ReturnType<typeof parseButtonPayload>] {
  const payload = encodeButtonPayload({ action, loadId: "4471", nonce });
  const event: InboundEvent = {
    kind: "inbound",
    wamid: `wamid.${action}.${nonce}`,
    serverAt: "2026-10-18T19:00:00.000Z",
    sender: e164 ? { kind: "phone", e164 } : { kind: "bsuid", id: "US.1", e164: null },
    body: { type: "button", payload },
  };
  return [event, parseButtonPayload(payload)];
}

async function run(action: "approve" | "hold", nonce?: string, e164?: string | null) {
  const [event, payload] = tap(action, nonce, e164);
  if (!isApprovalTap(payload)) throw new Error("not an approval tap");
  await handleApprovalTap(event, payload);
}

describe("dispatcher approval", () => {
  beforeAll(() => {
    Object.assign(process.env, {
      TABLE_NAME: "loads",
      DISPATCHER_PHONE: DISPATCHER,
      DRIVER_REPLIES: "on",
      DRIVER_ALLOWLIST: `+15550100001,${DISPATCHER}`,
      ORIGINATION_PHONE_ID: "phone-number-id-test",
      IDENTITY_SECRET_ARN: "arn:secret",
    });
  });

  beforeEach(() => {
    for (const m of [dynamo, sfn, messaging, secrets]) m.reset();
    request = { pk: "LOAD#4471", sk: "APPROVAL_REQUEST", token: "tok-1", nonce: "nonce01", requestedAt: "2026-10-18T18:00:00.000Z" };
    approval = undefined;
    secrets.on(GetSecretValueCommand).resolves({ SecretString: "k" });
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-1" });
    dynamo.on(GetCommand).resolves({});
    dynamo.on(GetCommand, { Key: { pk: "LOAD#4471", sk: "APPROVAL_REQUEST" } }).callsFake(() => ({ Item: request }));
    dynamo.on(GetCommand, { Key: { pk: "LOAD#4471", sk: "APPROVAL" } }).callsFake(() => ({ Item: approval }));
    dynamo.on(PutCommand).callsFake((input: { Item: Record<string, unknown> }) => {
      if (input.Item.sk === "APPROVAL") approval ??= input.Item;
      return {};
    });
    dynamo.on(UpdateCommand).callsFake((input: { Key: { sk: string }; ExpressionAttributeValues: Record<string, unknown> }) => {
      if (input.Key.sk === "APPROVAL_REQUEST" && request) request = { ...request, decidedAt: input.ExpressionAttributeValues[":t"], decision: input.ExpressionAttributeValues[":d"] };
      return {};
    });
  });

  it("puts the load id and nonce on both buttons of the approval template", () => {
    const body = JSON.stringify(approvalTemplate("4471", "nonce01", "the contract clause is met", "$80.00"));
    expect(body).toContain("dockclock_dispatch_approval");
    expect(body).toContain(encodeButtonPayload({ action: "approve", loadId: "4471", nonce: "nonce01" }));
    expect(body).toContain(encodeButtonPayload({ action: "hold", loadId: "4471", nonce: "nonce01" }));
  });

  it("does not page the dispatcher for a test load unless asked", async () => {
    dynamo.on(GetCommand, { Key: { pk: "LOAD#4471", sk: "META" } }).resolves({ Item: { loadId: "4471", sealedPackId: "4471-p", synthetic: true } });
    await requestApproval({ loadId: "4471", token: "tok-2", amountUsd: 80 });
    expect(messaging.calls()).toHaveLength(0);
    expect(sfn.commandCalls(SendTaskFailureCommand)[0]?.args[0].input).toMatchObject({ taskToken: "tok-2", error: "HeldByDispatch" });
  });

  it("records an approval and resumes the workflow with its id", async () => {
    await run("approve");
    expect(approval).toMatchObject({ approver: "dispatcher-whatsapp", approvalMessageId: "wamid.approve.nonce01" });
    const resumed = sfn.commandCalls(SendTaskSuccessCommand);
    expect(resumed).toHaveLength(1);
    expect(JSON.parse(resumed[0]!.args[0].input.output!)).toEqual({ decision: "approve", approvalId: approval?.approvalId });
    expect(request?.decision).toBe("approve");
    expect(messaging.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(1);
  });

  it("fails the waiting task on Hold and records no approval", async () => {
    await run("hold");
    expect(sfn.commandCalls(SendTaskFailureCommand)[0]?.args[0].input.error).toBe("HeldByDispatch");
    expect(approval).toBeUndefined();
  });

  it("ignores a tap from anyone but the dispatcher, or with a stale nonce", async () => {
    await run("approve", "nonce01", "+15550100001");
    await run("approve", "nonce01", null);
    await run("approve", "stale01");
    expect(sfn.calls()).toHaveLength(0);
    expect(approval).toBeUndefined();
  });

  it("acts once: a second tap after the decision changes nothing", async () => {
    await run("approve");
    await run("hold");
    expect(sfn.calls()).toHaveLength(1);
    expect(request?.decision).toBe("approve");
    const replies = messaging.commandCalls(SendWhatsAppMessageCommand).map((c) => Buffer.from(c.args[0].input.message as Uint8Array).toString());
    expect(replies.at(-1)).toContain("was already approved. Nothing changed.");
  });

  it("finishes a redelivered approval whose workflow already resumed", async () => {
    sfn.on(SendTaskSuccessCommand).rejects(Object.assign(new Error("used"), { name: "TaskTimedOut" }));
    await run("approve");
    expect(request?.decision).toBe("approve");
  });
});
