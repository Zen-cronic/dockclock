import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BatchGetCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { clauseById, evaluate } from "@dockclock/clause-engine";
import { buildPack, corroborate, facilityById, LocalSigner, sealPack, toLoadEvidence, type LoadRecord } from "@dockclock/evidence";
import { buildMime } from "@dockclock/mail";
import { findLeaks } from "@dockclock/sanitize";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../api/handler.js";
import { NOT_SENT, renderRcs, renderWhatsApp, sendRecord } from "../src/outbound.js";
import { RECEIPT_TEXT } from "../src/claim-receipt.js";
import { documentMessage } from "../src/sender.js";
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

  it("labels a SMOKE- load from before the synthetic flag as a test run", async () => {
    delete partitions["SMOKE-RCS-2"]![0]!.synthetic;
    const view = JSON.parse((await get("/api/loads/SMOKE-RCS-2")).body).data;
    expect(view.summary).toMatchObject({ runKind: "integration", runLabel: "Test run" });
    expect(view.clock.driverTimes).toBe("synthetic_input");
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

  it("ends an approval request nobody answered: needs a person, nothing filed", async () => {
    const items = partitions["SMOKE-RCS-1"]!;
    items.push({ pk: "LOAD#SMOKE-RCS-1", sk: "APPROVAL_REQUEST", requestedAt: T(17, 31) });
    const escalation = items.find((i) => String(i.sk).startsWith("EMAIL#escalation#"))!;
    Object.assign(escalation, { status: "sent", reason: "no approval within two days; nothing was sent; evidence confidence low" });
    const view = JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data;
    expect(view.summary).toMatchObject({ status: "needs_human", live: false });
    const step = (key: string) => view.workflow.find((s: { key: string }) => s.key === key);
    expect(step("approval")).toMatchObject({ state: "failed", detail: expect.stringContaining("No answer within two days") });
    expect(step("claim")).toMatchObject({ state: "skipped", detail: "Not filed: no approval." });
    expect(view.timeline.map((t: { title: string }) => t.title)).toContain("Approval timed out after two days; dispatch emailed, nothing filed");
  });

  it("times out an unanswered approval by its two-day wait even when the escalation record is missing", async () => {
    const items = partitions["SMOKE-RCS-1"]!;
    items.push({ pk: "LOAD#SMOKE-RCS-1", sk: "APPROVAL_REQUEST", requestedAt: T(17, 31) });
    // No escalation with the timeout reason: only the clock says the wait is over.
    const view = JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data;
    expect(view.summary.status).toBe("needs_human");
    expect(view.workflow.find((s: { key: string }) => s.key === "approval")).toMatchObject({ state: "failed" });
    // Inside the two days it is still waiting.
    items.find((i) => i.sk === "APPROVAL_REQUEST")!.requestedAt = new Date(Date.now() - 3_600_000).toISOString();
    expect(JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data.summary.status).toBe("awaiting_approval");
    // The workflow's own mark counts at once.
    items.find((i) => i.sk === "APPROVAL_REQUEST")!.decision = "timed_out";
    expect(JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data.summary.status).toBe("needs_human");
  });

  it("calls a claim-tool call filed only when the tool reports the email sent", async () => {
    const items = partitions["SMOKE-RCS-1"]!;
    const call = (result: Record<string, unknown>) => ({ name: "dockclock-tools___send_detention_claim", input: { loadId: "SMOKE-RCS-1", amountCents: 7500 }, status: "success", result });
    items.push({ pk: "LOAD#SMOKE-RCS-1", sk: `AGENT#${T(18, 1)}#file_claim`, task: "file_claim", startedAt: T(18, 1), toolCalls: [call({ sesMessageId: "x" })] });
    items.push({ pk: "LOAD#SMOKE-RCS-1", sk: `AGENT#${T(18, 5)}#file_claim`, task: "file_claim", startedAt: T(18, 5), toolCalls: [call({ sent: true, sesMessageId: "y" })] });
    const view = JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data;
    const results = view.agentRuns.map((r: { toolCalls: Array<{ result: { ok: boolean; summary: string } }> }) => r.toolCalls[0]!.result);
    expect(results[0]).toEqual({ ok: false, summary: "Not filed: the claim tool did not report the email sent." });
    expect(results[1]).toMatchObject({ ok: true });
    const titles = view.timeline.map((t: { title: string }) => t.title);
    expect(titles.filter((t: string) => t === "The AI agent filed the claim by email")).toHaveLength(1);
    const overview = JSON.parse((await get("/api/overview")).body).data;
    expect(overview.claims.refusedAgentRuns).toBe(1);
  });

  it("names the PDF claim summary send in plain words", async () => {
    const { purposeWords } = await import("../api/describe.js");
    expect(purposeWords("claim_receipt")).toBe("the PDF claim summary");
  });

  it("counts only filing runs after the approval when deciding a load needs a person", async () => {
    const items = partitions["SMOKE-RCS-1"]!;
    items.push({ pk: "LOAD#SMOKE-RCS-1", sk: "APPROVAL", approver: "dispatcher-whatsapp", approvedAt: T(18, 0) });
    items.push({ pk: "LOAD#SMOKE-RCS-1", sk: "APPROVAL_REQUEST", requestedAt: new Date(Date.now() - 3_600_000).toISOString(), decision: "approve", decidedAt: T(18, 0) });
    // Refused before the approval existed: not the filing run.
    items.push({ pk: "LOAD#SMOKE-RCS-1", sk: `AGENT#${T(17, 45)}#file_claim`, task: "file_claim", startedAt: T(17, 45), toolCalls: [] });
    expect(JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data.summary.status).toBe("filing");
    items.push({ pk: "LOAD#SMOKE-RCS-1", sk: `AGENT#${T(18, 1)}#file_claim`, task: "file_claim", startedAt: T(18, 1), toolCalls: [] });
    expect(JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data.summary.status).toBe("needs_human");
  });

  it("stops the clock of a closed load that arrived and was never released at its close", async () => {
    const meta = partitions["SMOKE-RCS-2"]![0]!;
    Object.assign(meta, { phase: "closed", outcome: "TIMED_OUT_NEEDS_HUMAN" });
    let clock = JSON.parse((await get("/api/loads/SMOKE-RCS-2")).body).data.clock;
    // No close time recorded: the end of the three-day release wait.
    expect(clock.endedAt).toBe("2026-10-16T13:50:00.000Z");
    expect(clock.releasedAt).toBeNull();
    const freeEnds = Date.parse(clock.freeTimeEndsAt);
    expect(clock.detentionMinutes).toBe((Date.parse(clock.endedAt) - freeEnds) / 60_000);
    meta.closedAt = T(15, 0);
    clock = JSON.parse((await get("/api/loads/SMOKE-RCS-2")).body).data.clock;
    expect(clock.endedAt).toBe(T(15, 0));
    expect(clock.detentionMinutes).toBe(Math.max(0, (Date.parse(T(15, 0)) - freeEnds) / 60_000));
    // A superseded load with no close time ends at its last record.
    Object.assign(meta, { outcome: "SUPERSEDED", closedAt: undefined });
    clock = JSON.parse((await get("/api/loads/SMOKE-RCS-2")).body).data.clock;
    expect(clock.endedAt).toBe(T(14, 30));
  });

  it("turns the What-if off when the rebuilt inputs contradict the sealed pack", async () => {
    let view = JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data;
    expect(view.verdict.whatIfAvailable).toBeUndefined();
    // The stored release pin no longer matches what was sealed.
    (partitions["SMOKE-RCS-1"]![0]!.released as Record<string, unknown>).serverAt = T(19, 50);
    view = JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data;
    expect(view.verdict).toMatchObject({ whatIfAvailable: false, whatIfNote: expect.stringContaining("sealed evaluation") });
    expect(view.verdict.verdict).toBe("BILLABLE");
  });

  it("keeps a judge DEMO load's typed text and photo off the public console", async () => {
    const items = partitions["SMOKE-RCS-1"]!;
    Object.assign(items[0]!, { demo: true, synthetic: false });
    const typed = "Jane Roe here, the gate code is 4471";
    const textEvent = items.find((i) => i.type === "text")!;
    textEvent.detail = { text: typed };
    const res = await get("/api/loads/SMOKE-RCS-1");
    expect(res.statusCode).toBe(200);
    const view = JSON.parse(res.body).data;
    expect(view.summary.runKind).toBe("demo");
    expect(res.body).not.toContain("Jane Roe");
    expect(res.body).not.toContain("gate code");
    expect(view.messages.find((m: { purpose: string }) => m.purpose === "text").body).toBe("Text reply (not shown publicly)");
    // Taps and pins still show.
    expect(view.messages.some((m: { purpose: string }) => m.purpose === "tap_arrived")).toBe(true);
    expect(view.messages.some((m: { purpose: string }) => m.purpose === "location")).toBe(true);
    expect(view.photos[0]).toMatchObject({ url: null, note: "Photo kept with the load; not shown publicly", sha256: "ab".repeat(32), matchesPack: true });
    expect(findLeaks(JSON.parse(res.body), ACCOUNT)).toEqual([]);
    const photo = await get("/api/loads/SMOKE-RCS-1/photos/1");
    expect(photo.statusCode).toBe(404);
    expect(photo.body).not.toContain("base64");
    for (const path of ["/api/messages", "/api/overview", "/api/messages?loadId=SMOKE-RCS-1"]) {
      const feed = await get(path);
      expect(feed.statusCode).toBe(200);
      expect(feed.body).not.toContain("Jane Roe");
      expect(findLeaks(JSON.parse(feed.body), ACCOUNT)).toEqual([]);
    }
    // A test load's text is still shown (scrubbed).
    Object.assign(items[0]!, { demo: false, synthetic: true });
    expect((await get("/api/loads/SMOKE-RCS-1")).body).toContain("Jane Roe");
  });

  it("retries receipts BatchGetItem left unprocessed, then gives up after a bounded number of tries", async () => {
    const keys = [{ pk: "MSG#out-wa", sk: "RECEIPT" }];
    dynamo.on(BatchGetCommand).resolvesOnce({ Responses: { loads: [] }, UnprocessedKeys: { loads: { Keys: keys } } }).resolves({ Responses: { loads: [{ pk: "MSG#out-wa", sk: "RECEIPT", failedAt: T(13, 4) }] } });
    const view = JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data;
    expect(view.messages.find((m: { kind: string }) => m.kind === "wa_template").status).toBe("failed");
    const { receiptsFor, RECEIPT_RETRIES } = await import("../api/store.js");
    dynamo.on(BatchGetCommand).resolves({ Responses: { loads: [] }, UnprocessedKeys: { loads: { Keys: keys } } });
    const waits: number[] = [];
    const before = dynamo.commandCalls(BatchGetCommand).length;
    await expect(receiptsFor(partitions["SMOKE-RCS-1"]!, async (ms) => waits.push(ms))).rejects.toThrow(/unread/);
    expect(dynamo.commandCalls(BatchGetCommand).length - before).toBe(RECEIPT_RETRIES + 1);
    expect(waits).toHaveLength(RECEIPT_RETRIES);
    expect(Math.max(...waits)).toBeLessThanOrEqual(1000);
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

  it("never serves a photo the evidence path refused (no hash)", async () => {
    const meta = partitions["SMOKE-RCS-1"]![0]!;
    meta.bol = { ...(meta.bol as Record<string, unknown>), photos: [{ mediaId: "m1", mimeType: "image/jpeg", s3Key: "rcs-inbound/rcs/SMOKE-RCS-1#bol.jpg" }] };
    expect((await get("/api/loads/SMOKE-RCS-1/photos/1")).statusCode).toBe(404);
    const view = JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data;
    expect(view.photos[0]).toMatchObject({ url: null, source: "not_stored", sha256: null });
  });

  it("refuses a stored photo that is not an image", async () => {
    objects["rcs-inbound/rcs/SMOKE-RCS-1#bol.jpg"] = "smoke bill of lading";
    const res = await get("/api/loads/SMOKE-RCS-1/photos/1");
    expect(res.statusCode).toBe(415);
    expect((await get("/api/loads/SMOKE-RCS-1/photos/2")).statusCode).toBe(404);
  });

  it("answers 415, not 500, for a truncated JPEG", async () => {
    objects["rcs-inbound/rcs/SMOKE-RCS-1#bol.jpg"] = gpsJpeg.subarray(0, gpsJpeg.length - 40);
    const res = await get("/api/loads/SMOKE-RCS-1/photos/1");
    expect(res.statusCode).toBe(415);
    expect(JSON.parse(res.body).error.code).toBe("unsupported_media");
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

  it("shows a text-and-HTML claim email's plain-text part and lists its PDF and pack with their hashes", async () => {
    const items = partitions["SMOKE-RCS-1"]!;
    const meta = items[0]!;
    const pdf = Buffer.from("%PDF-1.7\n% fake claim summary\n%%EOF\n");
    const packJson = String(objects[`packs/SMOKE-RCS-1/${String(meta.sealedPackId)}.json`]);
    const text = "Dear Freightline Digital (fictional broker),\n\nWe claim detention.\n\nAmount due: $1.00\n\nPublic key: https://d3djuoqhg6b8o2.cloudfront.net/keys/public-key.pem";
    objects["packs/SMOKE-RCS-1/claim.eml"] = buildMime({
      from: "DockClock Claims <claims@claims.kaungzinhein.com>",
      to: `someone+dc-broker@gmail.com`,
      replyTo: "dispatch@gmail.com",
      subject: "Detention claim: Load SMOKE-RCS-1 at Lakeshore DC, Columbus OH, $1.00",
      date: new Date(T(17, 40)),
      text,
      html: `<table><tr><td>${text}</td></tr></table>`,
      attachments: [
        { filename: "detention-claim-SMOKE-RCS-1.pdf", contentType: "application/pdf", content: pdf },
        { filename: `${String(meta.sealedPackId)}.json`, contentType: "application/json", content: packJson },
      ],
    });
    items.push({ pk: "LOAD#SMOKE-RCS-1", sk: "CLAIM", status: "sent", sentAt: T(17, 40), subject: "Detention claim", mimeKey: "packs/SMOKE-RCS-1/claim.eml", pdfKey: "packs/SMOKE-RCS-1/claim.pdf" });
    const view = JSON.parse((await get("/api/loads/SMOKE-RCS-1")).body).data as { emails: Array<{ id: string; attachments: Array<{ name: string; contentType: string; sha256: string; note: string }> }> };
    const claim = view.emails.find((e) => e.id === "claim")!;
    expect(claim.attachments).toEqual([
      { name: "detention-claim-SMOKE-RCS-1.pdf", contentType: "application/pdf", sha256: createHash("sha256").update(pdf).digest("hex"), note: "The one-page claim summary, as sent." },
      { name: `${String(meta.sealedPackId)}.json`, contentType: "application/json", sha256: createHash("sha256").update(packJson).digest("hex"), note: "The signed evidence pack, exactly as sealed." },
    ]);
    const res = await get("/api/loads/SMOKE-RCS-1/emails/claim");
    expect(res.statusCode).toBe(200);
    const email = JSON.parse(res.body).data as { body: string; bodyNote: string };
    expect(email.body).toBe(text);
    expect(email.body).not.toContain("<td>");
    expect(email.bodyNote).toBe("The sent email's bytes, kept with the load's packs. Its plain-text part is shown.");
    expect(findLeaks(JSON.parse(res.body), ACCOUNT)).toEqual([]);
    expect(res.body).not.toContain("gmail.com");
  });

  it("shows the PDF claim summary sent over WhatsApp as a document, with its file name, caption and hash", async () => {
    const items = partitions["SMOKE-RCS-1"]!;
    const sha = createHash("sha256").update("%PDF-1.7 fictional").digest("hex");
    const caption = RECEIPT_TEXT.en_US.caption("SMOKE-RCS-1", "$1.00");
    // As sendDocument records it: the rendered body plus the file's hash, never the media id or S3 key.
    const shown = { ...renderWhatsApp(documentMessage("1234567890123456", "detention-claim-SMOKE-RCS-1.pdf", caption)), document: { filename: "detention-claim-SMOKE-RCS-1.pdf", sha256: sha } };
    expect(shown).toEqual({ kind: "document", text: caption, document: { filename: "detention-claim-SMOKE-RCS-1.pdf", sha256: sha } });
    items.push(
      { ...sendRecord({ loadId: "SMOKE-RCS-1", messageId: "out-doc", channel: "whatsapp", purpose: "claim_receipt", audience: "dispatcher", sentAt: T(17, 41), message: shown }) },
      { ...sendRecord({ loadId: "SMOKE-RCS-1", messageId: "not-sent-doc", channel: "whatsapp", purpose: "claim_receipt", audience: "driver", sentAt: T(17, 42), message: shown, notSentReason: NOT_SENT.windowClosed }) },
    );
    const res = await get("/api/loads/SMOKE-RCS-1");
    expect(findLeaks(JSON.parse(res.body), ACCOUNT)).toEqual([]);
    const view = JSON.parse(res.body).data as { messages: Array<Record<string, unknown>>; timeline: Array<{ title: string; record?: Record<string, unknown> }> };
    const docs = view.messages.filter((m) => m.kind === "wa_document");
    expect(docs).toEqual([
      expect.objectContaining({ party: "dispatcher", purpose: "claim_receipt", body: caption, status: "accepted", document: { filename: "detention-claim-SMOKE-RCS-1.pdf", caption, sha256: sha } }),
      expect.objectContaining({ party: "driver", status: "not_sent", notSentReason: NOT_SENT.windowClosed, document: { filename: "detention-claim-SMOKE-RCS-1.pdf", caption, sha256: sha } }),
    ]);
    expect(res.body).not.toContain("1234567890123456");
    const feed = await get("/api/messages");
    expect(findLeaks(JSON.parse(feed.body), ACCOUNT)).toEqual([]);
    expect(JSON.parse(feed.body).data.items.some((m: { kind: string; preview: string }) => m.kind === "wa_document" && m.preview.startsWith("Claim summary for load SMOKE-RCS-1"))).toBe(true);
  });
});
