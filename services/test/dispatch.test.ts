import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SFNClient, StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handler, validate, workspaceOf, type DispatchInput } from "../src/dispatch.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const sfn = mockClient(SFNClient);
const messaging = mockClient(SocialMessagingClient);
const secrets = mockClient(SecretsManagerClient);

const input: DispatchInput = {
  loadId: "4471",
  clauseId: "lakeshore-foods",
  facilityId: "lakeshore-columbus",
  appointmentAt: "2026-10-19T08:00:00-04:00",
  channel: "whatsapp",
  address: { kind: "phone", e164: "+1 (555) 010-0001" },
  language: "en_US",
  optIn: { method: "onboarding_form", at: "2026-10-01T12:00:00Z" },
};

describe("dispatch validation", () => {
  it("rejects inputs that would create dead buttons or mis-timed loads, before storing anything", () => {
    expect(() => validate({ ...input, loadId: "PO_4471" })).toThrow(/loadId/);
    expect(() => validate({ ...input, loadId: "4471.2" })).toThrow(/loadId/);
    expect(() => validate({ ...input, appointmentAt: "2026-10-17T14:00" })).toThrow(/explicit offset/);
    expect(() => validate({ ...input, address: { kind: "phone", e164: "12" } })).toThrow(/phone/);
    expect(() => validate({ ...input, optIn: { method: "", at: "x" } })).toThrow(/opt-in/);
  });

  it("normalizes the dispatched number so it matches what WhatsApp reports", () => {
    expect(validate(input).address).toEqual({ kind: "phone", e164: "+15550100001" });
  });
});

describe("dispatch", () => {
  beforeAll(() => {
    Object.assign(process.env, {
      TABLE_NAME: "loads",
      STATE_MACHINE_ARN: "arn:sm",
      IDENTITY_SECRET_ARN: "arn:secret",
      ORIGINATION_PHONE_ID: "phone-number-id-test",
      DRIVER_REPLIES: "on",
      DRIVER_ALLOWLIST: "+15550100001",
    });
  });
  beforeEach(() => {
    for (const m of [dynamo, sfn, messaging, secrets]) m.reset();
    secrets.on(GetSecretValueCommand).resolves({ SecretString: "k" });
    dynamo.on(TransactWriteCommand).resolves({});
    dynamo.on(UpdateCommand).resolves({});
    sfn.on(StartExecutionCommand).resolves({ executionArn: "arn:exec:new" });
    sfn.on(StopExecutionCommand).resolves({});
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "tmpl-1" });
  });

  it("supersedes the driver's previous open load so its pins cannot leak into the new one", async () => {
    dynamo.on(GetCommand).callsFake((q: { Key: { pk: string } }) => {
      if (q.Key.pk.startsWith("OPTOUT#")) return {};
      if (q.Key.pk.startsWith("DRIVER#")) return { Item: { loadId: "OLD", dispatchedAt: "t" } };
      if (q.Key.pk === "LOAD#OLD") return { Item: { loadId: "OLD", phase: "awaiting_release_pin", executionArn: "arn:exec:old" } };
      return {};
    });
    const out = await handler(input);
    expect(out.superseded).toBe("OLD");
    expect(sfn.commandCalls(StopExecutionCommand)[0]?.args[0].input.executionArn).toBe("arn:exec:old");
    const close = dynamo.commandCalls(UpdateCommand).find((c) => c.args[0].input.ExpressionAttributeValues?.[":o"] === "SUPERSEDED");
    expect(close?.args[0].input.Key).toEqual({ pk: "LOAD#OLD", sk: "META" });
    expect(close?.args[0].input.UpdateExpression).toContain("closedAt = :t");
    expect(Date.parse(String(close?.args[0].input.ExpressionAttributeValues?.[":t"]))).toBeGreaterThan(Date.now() - 60_000);
  });

  it("waits for arrival until two days after the appointment, not two days after dispatch", async () => {
    dynamo.on(GetCommand).resolves({});
    // An appointment three days out, so the test does not depend on today's date.
    const appointmentAt = new Date(Date.now() + 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await handler({ ...input, appointmentAt });
    const started = JSON.parse(String(sfn.commandCalls(StartExecutionCommand)[0]?.args[0].input.input));
    const expected = Math.ceil((Date.parse(appointmentAt) - Date.now()) / 1000) + 2 * 86_400;
    expect(Math.abs(started.arrivalTimeoutSeconds - expected)).toBeLessThan(5);
  });

  it("reports a failed template send instead of throwing, leaving the load open for resend", async () => {
    dynamo.on(GetCommand).resolves({});
    messaging.on(SendWhatsAppMessageCommand).rejects(Object.assign(new Error("template paused"), { name: "ValidationException" }));
    const out = await handler(input);
    expect(out.templateMessageId).toBeNull();
    expect(out.dispatchError).toContain("template paused");
  });

  it("refuses a driver who replied STOP", async () => {
    dynamo.on(GetCommand).callsFake((q: { Key: { pk: string } }) => (q.Key.pk.startsWith("OPTOUT#") ? { Item: { at: "t" } } : {}));
    await expect(handler(input)).rejects.toThrow(/opted out/);
    expect(dynamo.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("lists judge, test and flagged operator loads in the demo workspace, and no others", async () => {
    expect(workspaceOf({ demo: true })).toBe("demo");
    expect(workspaceOf({ synthetic: true })).toBe("demo");
    expect(workspaceOf({ workspace: "demo" })).toBe("demo");
    expect(workspaceOf({})).toBeNull();
    expect(() => validate({ ...input, workspace: "prod" as never })).toThrow(/workspace/);
    dynamo.on(GetCommand).resolves({});
    const meta = async (extra: Partial<DispatchInput>) => {
      dynamo.resetHistory();
      await handler({ ...input, ...extra });
      const put = dynamo.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!.find((t) => t.Put?.Item?.sk === "META");
      return put!.Put!.Item as Record<string, unknown>;
    };
    expect((await meta({ workspace: "demo" })).ws).toBe("demo");
    expect((await meta({})).ws).toBeUndefined();
  });
});
