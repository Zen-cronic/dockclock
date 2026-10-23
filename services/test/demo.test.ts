import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { InboundEvent } from "@dockclock/whatsapp";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { demoLanguage, handleDemo } from "../src/demo.js";
import { outcomeText } from "../src/outcome.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const messaging = mockClient(SocialMessagingClient);
const secrets = mockClient(SecretsManagerClient);
const sfn = mockClient(SFNClient);
const JUDGE = "+15550100777";

let items: Map<string, Record<string, unknown>>;
let quota: Map<string, number>;

const text = (body: string, e164: string | null = JUDGE): InboundEvent => ({
  kind: "inbound",
  wamid: `wamid.${body}`,
  serverAt: "2026-10-18T21:00:00.000Z",
  sender: e164 ? { kind: "phone", e164 } : { kind: "bsuid", id: "US.42", e164: null },
  body: { type: "text", text: body },
});

const sentTexts = () => messaging.commandCalls(SendWhatsAppMessageCommand).map((c) => JSON.parse(Buffer.from(c.args[0].input.message as Uint8Array).toString()));

describe("judge demo", () => {
  beforeAll(() => {
    Object.assign(process.env, {
      TABLE_NAME: "loads",
      STATE_MACHINE_ARN: "arn:aws:states:us-east-1:111122223333:stateMachine:dockclock-load-lifecycle",
      DRIVER_REPLIES: "on",
      DRIVER_ALLOWLIST: "+15550100001",
      ORIGINATION_PHONE_ID: "phone-number-id-test",
      IDENTITY_SECRET_ARN: "arn:secret",
      DEMO_DAILY_LIMIT: "2",
    });
  });

  beforeEach(() => {
    for (const m of [dynamo, messaging, secrets, sfn]) m.reset();
    items = new Map();
    quota = new Map();
    secrets.on(GetSecretValueCommand).resolves({ SecretString: "k" });
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-1" });
    sfn.on(StartExecutionCommand).resolves({ executionArn: "arn:exec" });
    dynamo.on(GetCommand).callsFake(async (input: { Key: { pk: string; sk: string } }) => ({ Item: items.get(`${input.Key.pk}|${input.Key.sk}`) }));
    dynamo.on(PutCommand).callsFake(async (input: { Item: { pk: string; sk: string } }) => {
      items.set(`${input.Item.pk}|${input.Item.sk}`, input.Item);
      return {};
    });
    dynamo.on(TransactWriteCommand).resolves({});
    dynamo.on(UpdateCommand).callsFake(async (input: { Key: { pk: string; sk: string }; ExpressionAttributeValues?: Record<string, unknown> }) => {
      if (!input.Key.pk.startsWith("DEMOQUOTA#")) return {};
      const id = `${input.Key.pk}|${input.Key.sk}`;
      const n = quota.get(id) ?? 0;
      if (n >= Number(input.ExpressionAttributeValues?.[":limit"])) throw Object.assign(new Error("limit"), { name: "ConditionalCheckFailedException" });
      quota.set(id, n + 1);
      return {};
    });
  });

  it("recognises DEMO with an optional language", () => {
    expect(demoLanguage(text("DEMO"))).toBe("en_US");
    expect(demoLanguage(text(" demo es "))).toBe("es_MX");
    expect(demoLanguage(text("Demo FR."))).toBe("fr_CA");
    expect(demoLanguage(text("demo please"))).toBeNull();
    expect(demoLanguage(text("arrived"))).toBeNull();
  });

  it("enrols the sender, explains the demo and dispatches a demo load to them", async () => {
    await handleDemo(text("DEMO"), "en_US", []);
    expect([...items.keys()].some((k) => k.startsWith("DEMOUSER#"))).toBe(true);
    const sends = sentTexts();
    const intro: string = sends[0].text.body;
    for (const disclosure of ["about 10 minutes", "You are the truck driver and the dispatcher", "Free time is 5 minutes", "never to you", "Send DEMO again to start over", "5 a day per number, reset at 00:00 UTC", "US Eastern time", "not your location"]) {
      expect(intro).toContain(disclosure);
    }
    expect(sends[1].template.name).toBe("dockclock_load_dispatch");
    expect(sends.every((s) => s.to === JUDGE)).toBe(true);
    const load = dynamo.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems![0]!.Put!.Item!;
    expect(load).toMatchObject({ clauseId: "judge-demo", facilityId: "judge-demo", demo: true, synthetic: false });
  });

  it("stops at the daily limit and says so", async () => {
    await handleDemo(text("DEMO"), "en_US", []);
    await handleDemo(text("DEMO", "+15550100778"), "en_US", []);
    messaging.resetHistory();
    await handleDemo(text("DEMO", "+15550100779"), "en_US", []);
    expect(sentTexts().map((s) => s.text?.body)).toEqual(["The DockClock demo has reached today's limit. Please try again tomorrow."]);
    expect(sfn.commandCalls(StartExecutionCommand)).toHaveLength(2);
  });

  it("tells the judge the verdict and, after filing, what was sent", () => {
    const extra = { counterparty: "Demo Receiving Co. (fictional)", digest: "abcdef0123456789", amountUsd: 8.5 };
    expect(outcomeText({ kind: "verdict", loadId: "DEMO-1", verdict: "BILLABLE", amountUsd: 8.5, reasons: [] }, "en_US", true, extra)).toBe(
      "Load DEMO-1: the contract owes $8.50 in detention. Approve the claim in the next message.",
    );
    expect(outcomeText({ kind: "verdict", loadId: "DEMO-1", verdict: "NOT_BILLABLE", amountUsd: 0, reasons: ["WITHIN_FREE_TIME"] }, "en_US", true, extra)).toBe(
      "Load DEMO-1: no claim, because the wait stayed within free time.",
    );
    expect(outcomeText({ kind: "filed", loadId: "DEMO-1" }, "en_US", true, extra)).toBe(
      "Claim filed: $8.50 for load DEMO-1, emailed to Demo Receiving Co. (fictional) with the signed evidence pack (fingerprint abcdef01).",
    );
  });
});
