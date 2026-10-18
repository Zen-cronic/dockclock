import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { driverKeyWith } from "../src/identity.js";
import { bindPrimary, ownsLoad, resolveActiveLoad } from "../src/store.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const phoneKey = driverKeyWith("k", { kind: "phone", e164: "+15550100001" });
const bsuidKey = driverKeyWith("k", { kind: "bsuid", id: "US.abc", e164: "+15550100001" });
const record = (key: string, loadId: string, dispatchedAt: string, extra: Record<string, unknown> = {}) => ({
  Item: { pk: `DRIVER#${key}`, sk: "ACTIVE", loadId, dispatchedAt, address: { kind: "phone", e164: "+15550100001" }, ...extra },
});
const at = (key: string) => ({ Key: { pk: `DRIVER#${key}`, sk: "ACTIVE" } });

describe("driver identity", () => {
  beforeEach(() => {
    dynamo.reset();
    process.env.TABLE_NAME = "loads";
    dynamo.on(PutCommand).resolves({});
    dynamo.on(UpdateCommand).resolves({});
    dynamo.on(GetCommand).resolves({});
  });

  it("keys BSUID senders by BSUID, not by the phone that came with it", () => {
    expect(bsuidKey).toBe("bsuid:US.abc");
    expect(phoneKey).toMatch(/^phone:[a-f0-9]{32}$/);
  });

  it("routes a pin to the most recently dispatched load across BSUID and phone", async () => {
    dynamo.on(GetCommand, at(bsuidKey)).resolves(record(bsuidKey, "OLD", "2026-10-17T03:00:00.000Z", { boundFrom: phoneKey }));
    dynamo.on(GetCommand, at(phoneKey)).resolves(record(phoneKey, "NEW", "2026-10-17T03:23:38.000Z"));
    expect(await resolveActiveLoad([bsuidKey, phoneKey])).toEqual({ loadId: "NEW", key: phoneKey });
  });

  it("accepts a button from the dispatched phone or a BSUID bound from it, and nobody else", async () => {
    expect(await ownsLoad([bsuidKey, phoneKey], { driverKey: phoneKey })).toBe(true);
    dynamo.on(GetCommand, at(bsuidKey)).resolves(record(bsuidKey, "L1", "t", { boundFrom: phoneKey }));
    expect(await ownsLoad([bsuidKey], { driverKey: phoneKey })).toBe(true);
    expect(await ownsLoad([driverKeyWith("k", { kind: "bsuid", id: "US.other", e164: null })], { driverKey: phoneKey })).toBe(false);
  });

  it("binds the BSUID to the driver's live load and records the binding on the phone record", async () => {
    dynamo.on(GetCommand, at(phoneKey)).resolves(record(phoneKey, "NEW", "t2"));
    expect(await bindPrimary([bsuidKey, phoneKey], { loadId: "NEW", driverKey: phoneKey })).toBe(true);
    expect(dynamo.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({ pk: `DRIVER#${bsuidKey}`, loadId: "NEW", boundFrom: phoneKey });
    expect(dynamo.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues).toEqual({ ":b": bsuidKey });
  });

  it("never rebinds the BSUID to an older load when the driver taps an old message", async () => {
    // The phone's live load is NEW; a tap on OLD's button must not drag the BSUID back to OLD.
    dynamo.on(GetCommand, at(phoneKey)).resolves(record(phoneKey, "NEW", "t2", { boundBsuid: bsuidKey }));
    dynamo.on(GetCommand, at(bsuidKey)).resolves(record(bsuidKey, "NEW", "t2", { boundFrom: phoneKey }));
    expect(await bindPrimary([bsuidKey, phoneKey], { loadId: "OLD", driverKey: phoneKey })).toBe(false);
    expect(dynamo.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("returns null for a sender with no active load", async () => {
    expect(await resolveActiveLoad([bsuidKey])).toBeNull();
  });
});
