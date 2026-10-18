import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COPY } from "../src/messages.js";
import { handler, RETAKE_WAIT_SECONDS } from "../src/retake.js";

const dynamo = mockClient(DynamoDBDocumentClient);
let load: Record<string, unknown>;

describe("photo retake request", () => {
  beforeAll(() => {
    process.env.TABLE_NAME = "loads";
  });

  beforeEach(() => {
    dynamo.reset();
    load = { pk: "LOAD#DEMO-1", sk: "META", loadId: "DEMO-1", phase: "documented", flowSends: 1, bol: { messageId: "wamid.first", media: "hashed" }, demo: true };
    dynamo.on(GetCommand).callsFake(async () => ({ Item: structuredClone(load) }));
    dynamo.on(UpdateCommand).resolves({});
  });

  it("asks once, with the time the first photo will be used, and waits 10 minutes on a demo load", async () => {
    const before = Date.now();
    expect(await handler({ loadId: "DEMO-1" })).toEqual({ requested: true, waitSeconds: RETAKE_WAIT_SECONDS.demo });
    const update = dynamo.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.ConditionExpression).toBe("phase = :d AND attribute_not_exists(retakeOf)");
    const queued = Object.values(update.ExpressionAttributeValues!).filter((v) => typeof v === "object" && v !== null && "effect" in v) as Array<{ effect: { type: string; until?: string } }>;
    expect(queued.map((q) => q.effect.type)).toEqual(["ask_retake", "send_release_flow"]);
    const until = Date.parse(queued[0]!.effect.until!);
    expect(until - before).toBeGreaterThanOrEqual(RETAKE_WAIT_SECONDS.demo * 1000 - 1000);
    expect(until - before).toBeLessThan(RETAKE_WAIT_SECONDS.demo * 1000 + 5000);
  });

  it("waits an hour on a carrier's load", async () => {
    load.demo = undefined;
    expect(await handler({ loadId: "DEMO-1" })).toMatchObject({ requested: true, waitSeconds: RETAKE_WAIT_SECONDS.standard });
  });

  it("tells the driver the fallback time in every language", () => {
    expect(COPY.en_US.retakeAsk("21:10")).toContain("If none arrives by 21:10, we use the first photo.");
    expect(COPY.es_MX.retakeAsk("21:10")).toContain("21:10");
    expect(COPY.fr_CA.retakeAsk("21:10")).toContain("21:10");
  });
});
