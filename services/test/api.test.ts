import { readFileSync } from "node:fs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BatchGetCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { clauseById, evaluate } from "@dockclock/clause-engine";
import { buildPack, corroborate, facilityById, LocalSigner, sealPack, toLoadEvidence, type LoadRecord } from "@dockclock/evidence";
import { findLeaks } from "@dockclock/sanitize";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../api/handler.js";
import { renderRcs } from "../src/outbound.js";
import { rcsDispatchCard } from "../src/rcs.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const ACCOUNT = "925432502717";
const PHONE = "+15550100001";
const BSUID = "US.13491208655302741918";
const INSIDE: [number, number] = [-82.938, 39.8995];
const facility = facilityById("lakeshore-columbus");
const wamid = (n: number) => `wamid.${Buffer.from(`\u0018\u000b15550100001\u0015\u0002${n}ABCDEF`).toString("base64")}`;
const T = (h: number, m: number) => `2026-10-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const gpsJpeg = readFileSync(new URL("../../packages/sanitize/test/fixtures/gps-exif.jpg", import.meta.url));

let partitions: Record<string, Array<Record<string, unknown>>>;
let objects: Record<string, Buffer | string>;

async function rcsLoad(loadId: string, sealed: boolean) {
  const record: LoadRecord = {
    loadId,
    clauseId: "freightline-digital",
    facility,
    appointmentAt: T(14, 0),
    arrived: { kind: "arrived", channel: "rcs", messageId: "rcs-in-2", serverAt: T(13, 50), location: INSIDE },
    released: { kind: "released", channel: "rcs", messageId: "rcs-in-6", serverAt: T(17, 20), location: INSIDE },
    bol: { channel: "rcs", messageId: "rcs-in-7", serverAt: T(17, 25), cameraOnly: false, pageSha256s: ["ab".repeat(32)], timesEdited: { in: false, out: false }, signed: false, checkIn: null, checkOut: null, confirmedByDriver: false },
    status214: false,
    notice: null,
    shipperConfirmation: null,
  };
  const evaluation = evaluate(toLoadEvidence(record, T(17, 30)), clauseById("freightline-digital"));
  const pack = buildPack(record, corroborate(record), evaluation, T(17, 30));
  const signed = { ...(await sealPack(pack, new LocalSigner())), keyId: `arn:aws:kms:us-east-1:${ACCOUNT}:key/x` };
  const pin = (n: number, at: string) => ({ channel: "rcs", messageId: `rcs-in-${n}`, serverAt: at, lat: INSIDE[1], lon: INSIDE[0] });
  const ev = (n: number, at: string, type: string, outcome: string, detail: Record<string, unknown>) => ({ pk: `LOAD#${loadId}`, sk: `EVENT#${at}#${wamid(n)}`, messageId: wamid(n), serverAt: at, type, outcome, channel: "rcs", detail });
  const meta: Record<string, unknown> = {
    pk: `LOAD#${loadId}`,
    sk: "META",
    loadId,
    ws: "demo",
    synthetic: true,
    clauseId: "freightline-digital",
    facilityId: "lakeshore-columbus",
    appointmentAt: T(14, 0),
    createdAt: T(13, 0),
    address: { kind: "phone", e164: PHONE },
    boundBsuid: BSUID,
    driverKey: "phone:abc",
    executionArn: `arn:aws:states:us-east-1:${ACCOUNT}:execution:x:y`,
    tokens: { arrived: "secret-token" },
    nonce: "68220ac1613f",
    language: "en_US",
    channel: "rcs",
    phase: sealed ? "sealed" : "at_dock",
    arrived: pin(2, T(13, 50)),
    released: sealed ? pin(6, T(17, 20)) : null,
    bol: sealed ? { channel: "rcs", messageId: "rcs-in-7", serverAt: T(17, 25), photos: [{ mediaId: "m1", mimeType: "image/jpeg", s3Key: `rcs-inbound/rcs/${loadId}#bol.jpg`, sha256: "ab".repeat(32) }], media: "hashed" } : null,
    ...(sealed ? { sealedPackId: pack.packId, verdict: evaluation.verdict, sealedAt: T(17, 30) } : {}),
  };
  const items: Array<Record<string, unknown>> = [
    meta,
    ev(1, T(13, 49), "button", "ADVANCED", { payload: `dc1.arrived.${loadId}.68220ac1613f` }),
    ev(2, T(13, 50), "location", "ADVANCED", { lat: INSIDE[1], lon: INSIDE[0] }),
    ev(3, T(14, 30), "text", "IGNORED", { text: `call me at ${PHONE}` }),
    { pk: `LOAD#${loadId}`, sk: `EVENT#${T(13, 5)}#failover.x`, type: "failover", outcome: "RESENT_OVER_RCS", channel: "rcs", serverAt: T(13, 5), messageId: "out-wa", detail: { failedMessageId: "out-wa", from: PHONE, purpose: "dispatch_template" } },
    { pk: `LOAD#${loadId}`, sk: `SEND#${T(13, 0)}#out-wa`, kind: "send", messageId: "out-wa", channel: "whatsapp", purpose: "dispatch_template", audience: "driver", sentAt: T(13, 0), message: { kind: "template", template: { name: "dockclock_load_dispatch", language: "en_US" }, text: "Load booked", buttons: ["Arrived", "Talk to dispatch"] } },
    { pk: `LOAD#${loadId}`, sk: `SEND#${T(13, 6)}#not-sent-1`, kind: "send", messageId: "not-sent-1", channel: "rcs", purpose: "dispatch_card", audience: "driver", sentAt: T(13, 6), message: renderRcs(rcsDispatchCard("en_US", loadId, "68220ac1613f", "Lakeshore DC", "Oct 13")), status: "not_sent", notSentReason: "Not sent: the recipient is a test number." },
    { pk: `LOAD#${loadId}`, sk: `EMAIL#escalation#${T(15, 0)}#not-sent-2`, kind: "email", purpose: "dispatch_escalation", sentAt: T(15, 0), subject: "needs dispatch", text: `Driver: ${PHONE}`, status: "not_sent", notSentReason: "Not sent: test loads never email dispatch." },
  ];
  if (sealed) {
    items.push({ pk: `LOAD#${loadId}`, sk: `PACK#${pack.packId}`, s3Key: `packs/${loadId}/${pack.packId}.json`, keyId: signed.keyId, amountUsd: evaluation.amountUsd, verdict: evaluation.verdict, confidence: "low" });
    objects[`packs/${loadId}/${pack.packId}.json`] = JSON.stringify(signed);
    objects[`rcs-inbound/rcs/${loadId}#bol.jpg`] = gpsJpeg;
  }
  partitions[loadId] = items;
  return { evaluation };
}

describe("console read API", () => {
  beforeAll(() => Object.assign(process.env, { TABLE_NAME: "loads", EVIDENCE_BUCKET: "evidence", MEDIA_BUCKET: "media", ACCOUNT_ID: ACCOUNT, EVIDENCE_SPKI_SHA256: "spki" }));
  beforeEach(async () => {
    dynamo.reset();
    s3.reset();
    partitions = {};
    objects = {};
    await rcsLoad("SMOKE-RCS-1", true);
    await rcsLoad("SMOKE-RCS-2", false);
    partitions["LIVE-op1"] = [{ pk: "LOAD#LIVE-op1", sk: "META", loadId: "LIVE-op1", clauseId: "lakeshore-foods", facilityId: "lakeshore-columbus", phase: "sealed", appointmentAt: T(14, 0) }];
    dynamo.on(QueryCommand).callsFake(async (q: { IndexName?: string; ExpressionAttributeValues: Record<string, string> }) => {
      if (q.IndexName) return { Items: Object.values(partitions).map((items) => items[0]).filter((m) => m?.ws === "demo") };
      return { Items: partitions[q.ExpressionAttributeValues[":p"]!.slice(5)] ?? [] };
    });
    dynamo.on(BatchGetCommand).resolves({ Responses: { loads: [{ pk: "MSG#out-wa", sk: "RECEIPT", failedAt: T(13, 4), failoverAt: T(13, 5), failoverAction: "RESENT_OVER_RCS" }] } });
    s3.on(GetObjectCommand).callsFake(async (input: { Key: string; Range?: string }) => {
      const body = objects[input.Key];
      if (body === undefined) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      const bytes = Buffer.from(body);
      const out = input.Range ? bytes.subarray(0, 16) : bytes;
      return { Body: { transformToByteArray: async () => new Uint8Array(out), transformToString: async () => out.toString("utf8") } };
    });
  });

  const get = async (path: string) => {
    const [rawPath, rawQueryString = ""] = path.split("?");
    return handler({ rawPath: rawPath!, rawQueryString, requestContext: { http: { method: "GET" } } });
  };

  it.each(["/api/overview", "/api/loads", "/api/messages", "/api/messages?channel=rcs", "/api/loads/SMOKE-RCS-1", "/api/loads/SMOKE-RCS-2", "/api/loads/SMOKE-RCS-1/pack", "/api/loads/SMOKE-RCS-1/emails/escalation-1"])("serves %s with nothing sensitive in it", async (path) => {
    const res = await get(path);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.schema).toBe("dockclock.api/1");
    expect(findLeaks(body, ACCOUNT)).toEqual([]);
    for (const secret of [PHONE, BSUID, ACCOUNT, "68220ac1613f", "secret-token", "wamid.", "rcs-inbound/", String(INSIDE[1])]) expect(res.body).not.toContain(secret);
  });

  it("lists demo-workspace loads only and answers 404 for any other load", async () => {
    const list = JSON.parse((await get("/api/loads")).body);
    expect(list.data.loads.map((l: { loadId: string }) => l.loadId).sort()).toEqual(["SMOKE-RCS-1", "SMOKE-RCS-2"]);
    const res = await get("/api/loads/LIVE-op1");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("not_found");
    expect((await get("/api/loads/LIVE-op1/pack")).statusCode).toBe(404);
    expect((await get("/api/loads/..%2Fsecret")).statusCode).toBe(404);
  });

  it("shows a live RCS load as at the dock, polls it, and has no pack yet", async () => {
    const view = JSON.parse((await get("/api/loads/SMOKE-RCS-2")).body);
    expect(view.pollMs).toBe(3000);
    expect(view.data.summary).toMatchObject({ status: "at_dock", live: true, channels: ["whatsapp", "rcs"], failover: true });
    expect(view.data.pack).toBeNull();
    expect(view.data.verdict).toBeNull();
    expect(view.data.workflow.find((s: { key: string }) => s.key === "released").state).toBe("current");
    expect((await get("/api/loads/SMOKE-RCS-2/pack")).statusCode).toBe(404);
  });

  it("draws the RCS lane with its own kinds and marks the failed WhatsApp send", async () => {
    const view = JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data;
    const kinds = view.messages.map((m: { kind: string }) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(["wa_template", "rcs_rich_card", "rcs_suggestion_reply", "rcs_location", "rcs_text_reply"]));
    const failed = view.messages.find((m: { kind: string }) => m.kind === "wa_template");
    expect(failed).toMatchObject({ status: "failed", failover: { action: "rerouted_to_rcs" } });
    const card = view.messages.find((m: { kind: string }) => m.kind === "rcs_rich_card");
    expect(card).toMatchObject({ status: "not_sent", actions: [{ type: "rcs_reply" }, { type: "rcs_reply" }] });
    expect(view.summary).toMatchObject({ verdict: "BILLABLE", status: "held" });
    expect(view.photos[0]).toMatchObject({ id: "p1", sha256: "ab".repeat(32), matchesPack: true, url: "/api/loads/SMOKE-RCS-1/photos/1", source: "rendered_fictional_document" });
    expect(view.emails[0]).toMatchObject({ id: "escalation-1", status: "not_sent" });
  });

  it("serves a photo without its EXIF or GPS, naming the original's hash", async () => {
    const res = await get("/api/loads/SMOKE-RCS-1/photos/1");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["x-dockclock-original-sha256"]).toBe("ab".repeat(32));
    const bytes = Buffer.from(res.body, "base64");
    expect(bytes.toString("latin1")).not.toContain("Exif");
    expect(bytes.toString("latin1")).not.toContain("fake GPS");
    expect(gpsJpeg.toString("latin1")).toContain("Exif");
  });

  it("refuses a stored photo that is not an image", async () => {
    objects["rcs-inbound/rcs/SMOKE-RCS-1#bol.jpg"] = "smoke bill of lading";
    const res = await get("/api/loads/SMOKE-RCS-1/photos/1");
    expect(res.statusCode).toBe(415);
    expect((await get("/api/loads/SMOKE-RCS-1/photos/2")).statusCode).toBe(404);
  });

  it("fails closed: a response that would leak is never sent", async () => {
    // A stored field the builder passes through as is (the notice schedule time) carries a number.
    partitions["SMOKE-RCS-2"]![0]!.notice = { scheduledFor: `call ${PHONE}` };
    const res = await get("/api/loads/SMOKE-RCS-2");
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(PHONE);
    expect(JSON.parse(res.body).error.code).toBe("internal");
  });

  it("is read only and validates its parameters", async () => {
    expect((await handler({ rawPath: "/api/loads", requestContext: { http: { method: "POST" } } })).statusCode).toBe(400);
    expect((await get("/api/messages?channel=fax")).statusCode).toBe(400);
    expect((await get("/api/loads?limit=0")).statusCode).toBe(400);
    expect((await get("/api/nope")).statusCode).toBe(404);
  });
});
