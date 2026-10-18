import { clauseById, evaluate } from "@dockclock/clause-engine";
import { corroborate, toLoadEvidence } from "@dockclock/evidence";
import { describe, expect, it } from "vitest";
import type { LoadItem } from "../src/store.js";
import { toRecord } from "../src/seal.js";

// Pins inside the Lakeshore yard; the Flow pre-fills 09:52 / 13:18 (EDT) from them.
const base = {
  pk: "LOAD#4471",
  sk: "META",
  loadId: "4471",
  nonce: "abc123",
  phase: "documented",
  version: 6,
  flowSends: 1,
  clauseId: "lakeshore-foods",
  facilityId: "lakeshore-columbus",
  appointmentAt: "2026-10-13T14:00:00.000Z",
  driverKey: "phone:x",
  address: { kind: "phone", e164: "+15550100001" },
  channel: "whatsapp",
  language: "en_US",
  tokens: {},
  arrived: { serverAt: "2026-10-13T13:52:00.000Z", messageId: "a", lat: 39.8995, lon: -82.938 },
  released: { serverAt: "2026-10-13T17:18:00.000Z", messageId: "r", lat: 39.8995, lon: -82.938 },
} as unknown as LoadItem;

const bol = (overrides: Record<string, unknown>) => ({
  serverAt: "2026-10-13T17:25:00.000Z",
  messageId: "b",
  photos: [{ mediaId: "m1", mimeType: "image/jpeg", metaSha256: null, sha256: "ab".repeat(32) }],
  inTime: "09:52",
  outTime: "13:18",
  delayReason: "dock_not_ready",
  consignee: "not signed",
  receiverSigned: false,
  shareConsent: true,
  media: "hashed" as const,
  ...overrides,
});

describe("sealed evidence is honest about what the driver supplied", () => {
  it("does not treat a typed name as a signature, or pre-filled times as corroboration", () => {
    const record = toRecord({ ...base, bol: bol({}) });
    expect(record.bol?.signed).toBe(false);
    expect(record.bol?.timesEdited).toEqual({ in: false, out: false });
    expect(corroborate(record).confidence).toBe("medium");
    const result = evaluate(toLoadEvidence(record, "2026-10-13T18:00:00.000Z"), clauseById("lakeshore-foods"));
    expect(result.verdict).toBe("NOT_BILLABLE");
    expect(result.reasons).toContain("NO_STATEMENT_OF_RECORD");
  });

  it("counts a ticked signature and times the driver actually changed", () => {
    const record = toRecord({ ...base, bol: bol({ receiverSigned: true, inTime: "9:55 AM", outTime: "1:16 PM" }) });
    expect(record.bol?.signed).toBe(true);
    expect(record.bol?.timesEdited).toEqual({ in: true, out: true });
    expect(corroborate(record).confidence).toBe("high");
  });

  it("attests every stored page in the pack", () => {
    const record = toRecord({
      ...base,
      bol: bol({ photos: [{ mediaId: "m1", sha256: "ab".repeat(32) }, { mediaId: "m2" }, { mediaId: "m3", sha256: "cd".repeat(32) }], media: "unavailable" }),
    });
    expect(record.bol?.pageSha256s).toEqual(["ab".repeat(32), null, "cd".repeat(32)]);
  });
});

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { handler as seal } from "../src/seal.js";

describe("seal", () => {
  it("returns the existing pack when a retried or redriven execution seals again", async () => {
    Object.assign(process.env, { TABLE_NAME: "loads", EVIDENCE_BUCKET: "evidence", EVIDENCE_KEY_ARN: "arn:key", MEDIA_BUCKET: "media" });
    const dynamo = mockClient(DynamoDBDocumentClient);
    const s3 = mockClient(S3Client);
    const kms = mockClient(KMSClient);
    dynamo.on(GetCommand, { Key: { pk: "LOAD#4471", sk: "META" } }).resolves({ Item: { ...base, sealedPackId: "4471-abc" } });
    dynamo.on(GetCommand, { Key: { pk: "LOAD#4471", sk: "PACK#4471-abc" } }).resolves({ Item: { s3Key: "packs/4471/4471-abc.json", digest: "d", verdict: "BILLABLE", confidence: "high" } });
    const out = await seal({ loadId: "4471" });
    expect(out).toEqual({ packId: "4471-abc", s3Key: "packs/4471/4471-abc.json", digest: "d", verdict: "BILLABLE", confidence: "high" });
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(kms.commandCalls(SignCommand)).toHaveLength(0);
    for (const m of [dynamo, s3, kms]) m.restore();
  });
});
