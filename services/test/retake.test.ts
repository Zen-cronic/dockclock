import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failoverEffect } from "../src/lifecycle.js";
import { COPY } from "../src/messages.js";
import { handler, RETAKE_WAIT_SECONDS } from "../src/retake.js";

const dynamo = mockClient(DynamoDBDocumentClient);
let load: Record<string, unknown>;

// Every describe below shares this setup, so each test runs the same alone (vitest -t) as in the suite.
beforeEach(() => {
  for (const [name, value] of Object.entries({
    TABLE_NAME: "loads",
    DRIVER_REPLIES: "on",
    DRIVER_ALLOWLIST: "+15550100001",
    ORIGINATION_PHONE_ID: "phone-number-id-test",
    IDENTITY_SECRET_ARN: "arn:secret",
  })) {
    vi.stubEnv(name, value);
  }
  dynamo.reset();
  load = { pk: "LOAD#DEMO-1", sk: "META", loadId: "DEMO-1", phase: "documented", flowSends: 1, bol: { messageId: "wamid.first", media: "hashed" }, demo: true };
  dynamo.on(GetCommand).callsFake(async () => ({ Item: structuredClone(load) }));
  dynamo.on(UpdateCommand).resolves({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("photo retake request", () => {
  it("asks once, with the time the first photo will be used, and waits 10 minutes on a demo load", async () => {
    const before = Date.now();
    expect(await handler({ loadId: "DEMO-1" })).toEqual({ requested: true, waitSeconds: RETAKE_WAIT_SECONDS.demo });
    const update = dynamo.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.ConditionExpression).toBe("phase = :d AND attribute_not_exists(retakeOf)");
    const queued = Object.values(update.ExpressionAttributeValues!).filter((v) => typeof v === "object" && v !== null && "effect" in v) as Array<{ effect: { type: string } }>;
    expect(queued.map((q) => q.effect.type)).toEqual(["ask_retake", "send_release_flow"]);
    // The deadline is stored on the load, so a replay or an RCS re-send reads the same deadline.
    const until = Date.parse(update.ExpressionAttributeValues![":u"] as string);
    expect(until - before).toBeGreaterThanOrEqual(RETAKE_WAIT_SECONDS.demo * 1000 - 1000);
    expect(until - before).toBeLessThan(RETAKE_WAIT_SECONDS.demo * 1000 + 5000);
  });

  it("on a retried step, reports the request already made and the time left instead of sealing", async () => {
    load = { ...load, phase: "awaiting_bol", retakeOf: "wamid.first", retakeUntil: new Date(Date.now() + 7 * 60_000).toISOString() };
    const result = await handler({ loadId: "DEMO-1" });
    expect(result.requested).toBe(true);
    expect(result.waitSeconds).toBeGreaterThan(6 * 60);
    expect(result.waitSeconds).toBeLessThanOrEqual(7 * 60);
    expect(dynamo.commandCalls(UpdateCommand).some((c) => String(c.args[0].input.UpdateExpression).startsWith("SET phase"))).toBe(false);
  });

  it("waits an hour on a carrier's load", async () => {
    load.demo = undefined;
    expect(await handler({ loadId: "DEMO-1" })).toMatchObject({ requested: true, waitSeconds: RETAKE_WAIT_SECONDS.standard });
  });

  it("tells the driver the minutes left and a zone-labelled time, in every language", () => {
    expect(COPY.en_US.retakeAsk(10, "21:10", "EDT", true)).toContain("one more of the paper");
    expect(COPY.en_US.retakeAsk(60, "13:10", "CDT", false)).toContain("one more of the signed bill of lading");
    expect(COPY.en_US.retakeAsk(10, "21:10", "EDT", true)).toContain("If none arrives within 10 minutes (by 21:10 EDT), we use the first photo.");
    expect(COPY.es_MX.retakeAsk(10, "21:10", "EDT", true)).toContain("10 minutos (antes de las 21:10 EDT)");
    expect(COPY.fr_CA.retakeAsk(10, "21:10", "EDT", true)).toContain("10 minutes (avant 21:10 EDT)");
    expect(COPY.en_US.retakeAsk(1, "21:10", "EDT", true)).toContain("within 1 minute (by");
    expect(COPY.es_MX.retakeAsk(1, "21:10", "EDT", true)).toContain("en 1 minuto (antes");
    expect(COPY.fr_CA.retakeAsk(1, "21:10", "EDT", true)).toContain("d'ici 1 minute (avant");
  });

  it("is re-sent over RCS when the WhatsApp ask fails, while the load still waits", () => {
    expect(failoverEffect("ask_retake", "awaiting_bol")).toEqual({ type: "ask_retake" });
    expect(failoverEffect("ask_retake", "sealed")).toBeNull();
  });
});

describe("a queued retake ask replayed late", () => {
  it("sends nothing once the deadline has passed, and leaves the queue unblocked", async () => {
    const { SendWhatsAppMessageCommand, SocialMessagingClient } = await import("@aws-sdk/client-socialmessaging");
    const messaging = mockClient(SocialMessagingClient);
    const late = {
      ...load,
      phase: "awaiting_bol",
      facilityId: "lakeshore-columbus",
      language: "en_US",
      channel: "whatsapp",
      address: { kind: "phone", e164: "+15550100001" },
      driverKey: "phone:x",
      retakeUntil: new Date(Date.now() - 60_000).toISOString(),
      outbox: { "a#retake#1": { seq: "a#retake#1", effect: { type: "ask_retake" } } },
    };
    dynamo.on(GetCommand).resolves({ Item: late });
    const { drainOutbox } = await import("../src/ingest.js");
    expect(await drainOutbox("DEMO-1")).toBe(1);
    expect(messaging.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
    expect(dynamo.commandCalls(UpdateCommand).some((c) => c.args[0].input.UpdateExpression === "REMOVE outbox.#k")).toBe(true);
  });
});

describe("an outbox entry from an older build", () => {
  it("drops a message key this build no longer has and still sends what is queued behind it", async () => {
    const { SendWhatsAppMessageCommand, SocialMessagingClient } = await import("@aws-sdk/client-socialmessaging");
    const { GetSecretValueCommand, SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
    const messaging = mockClient(SocialMessagingClient);
    mockClient(SecretsManagerClient).on(GetSecretValueCommand).resolves({ SecretString: "k" });
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-1" });
    const queued = {
      ...load,
      phase: "awaiting_bol",
      facilityId: "lakeshore-columbus",
      language: "en_US",
      channel: "whatsapp",
      address: { kind: "phone", e164: "+15550100001" },
      driverKey: "phone:x",
      outbox: {
        "a#1": { seq: "a#1", effect: { type: "tell_driver", key: "bol_retake" } },
        "a#2": { seq: "a#2", effect: { type: "tell_driver", key: "bol_received" } },
      },
    };
    dynamo.on(GetCommand).resolves({});
    dynamo.on(GetCommand, { Key: { pk: "LOAD#DEMO-1", sk: "META" } }).resolves({ Item: queued });
    const { drainOutbox } = await import("../src/ingest.js");
    expect(await drainOutbox("DEMO-1")).toBe(2);
    const sent = messaging.commandCalls(SendWhatsAppMessageCommand).map((c) => JSON.parse(Buffer.from(c.args[0].input.message as Uint8Array).toString()).text.body);
    expect(sent).toEqual(["Got it. Your photo and times are saved with this load's evidence."]);
  });
});

describe("a queued prompt replayed after the load moved on", () => {
  it("is dropped, not sent, once the load is sealed", async () => {
    const { SendWhatsAppMessageCommand, SocialMessagingClient } = await import("@aws-sdk/client-socialmessaging");
    const messaging = mockClient(SocialMessagingClient);
    const sealed = {
      ...load,
      phase: "sealed",
      facilityId: "lakeshore-columbus",
      language: "en_US",
      channel: "whatsapp",
      address: { kind: "phone", e164: "+15550100001" },
      driverKey: "phone:x",
      outbox: { "a#retake#2": { seq: "a#retake#2", effect: { type: "send_release_flow" } } },
    };
    dynamo.on(GetCommand).resolves({ Item: sealed });
    const { drainOutbox } = await import("../src/ingest.js");
    expect(await drainOutbox("DEMO-1")).toBe(1);
    expect(messaging.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
    expect(dynamo.commandCalls(UpdateCommand).some((c) => c.args[0].input.UpdateExpression === "REMOVE outbox.#k")).toBe(true);
  });
});
