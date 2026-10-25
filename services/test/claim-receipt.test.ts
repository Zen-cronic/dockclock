import { createHash } from "node:crypto";
import { PinpointSMSVoiceV2Client, SendRcsMessageCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { PostWhatsAppMessageMediaCommand, SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LANGUAGES } from "../src/messages.js";
import { NOT_SENT } from "../src/outbound.js";
import { handler as tellOutcome } from "../src/outcome.js";
import { ALREADY_HANDLED, RECEIPT_TEXT, sendClaimReceipts, windowOpen } from "../src/claim-receipt.js";
import type { LoadItem } from "../src/store.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const messaging = mockClient(SocialMessagingClient);
const sms = mockClient(PinpointSMSVoiceV2Client);
const s3 = mockClient(S3Client);
const secrets = mockClient(SecretsManagerClient);

// Fictional 555 numbers only.
const DRIVER = "+15550100001";
const DISPATCHER = "+15550100009";
const STRANGER = "+15550100002";
const PDF = new TextEncoder().encode("%PDF-1.7 fictional claim summary");
const PDF_SHA = createHash("sha256").update(PDF).digest("hex");

const recently = () => new Date(Date.now() - 30 * 60_000).toISOString();
const longAgo = () => new Date(Date.now() - 25 * 60 * 60_000).toISOString();

let load: LoadItem;
let claim: Record<string, unknown> | undefined;
let events: Array<Record<string, unknown>>;
let optedOut: Set<string>;
// Receipt reservations taken on the CLAIM record (attribute names), as DynamoDB would keep them.
let reserved: Set<string>;

function baseLoad(over: Partial<LoadItem> = {}): LoadItem {
  return {
    pk: "LOAD#L1",
    sk: "META",
    loadId: "L1",
    phase: "sealed",
    clauseId: "atlas-brokerage",
    facilityId: "lakeshore-columbus",
    appointmentAt: "2026-10-23T13:00:00.000Z",
    driverKey: "phone:driver",
    address: { kind: "phone", e164: DRIVER },
    channel: "whatsapp",
    language: "en_US",
    tokens: {},
    sealedPackId: "pack-1",
    ...over,
  } as LoadItem;
}

type Sent = { to?: string; type: string; document?: { id: string; filename: string; caption: string }; text?: { body: string } };
const whatsappSent = (): Sent[] => messaging.commandCalls(SendWhatsAppMessageCommand).map((c) => JSON.parse(Buffer.from(c.args[0].input.message as Uint8Array).toString()) as Sent);
const records = () => dynamo.commandCalls(PutCommand).map((c) => c.args[0].input.Item as Record<string, unknown>).filter((i) => String(i.sk).startsWith("SEND#") && i.purpose === "claim_receipt");

describe("the PDF claim summary goes back over WhatsApp after filing", () => {
  beforeAll(() => {
    Object.assign(process.env, {
      TABLE_NAME: "loads",
      EVIDENCE_BUCKET: "evidence-bucket",
      ORIGINATION_PHONE_ID: "phone-number-id-test",
      DRIVER_REPLIES: "on",
      DRIVER_ALLOWLIST: `${DRIVER},${DISPATCHER}`,
      DISPATCHER_PHONE: DISPATCHER,
      IDENTITY_SECRET_ARN: "arn:secret",
      RCS_AGENT_ID: "rcs-agent-test",
      RCS_TOPIC_ARN: "arn:topic",
      MEDIA_BUCKET: "media-bucket",
    });
  });

  beforeEach(() => {
    for (const m of [dynamo, messaging, sms, s3, secrets]) m.reset();
    load = baseLoad();
    claim = { pk: "LOAD#L1", sk: "CLAIM", status: "sent", amountUsd: 17.28, pdfKey: "packs/L1/claim.pdf", pdfName: "detention-claim-L1.pdf" };
    events = [{ sk: `EVENT#${recently()}#w1`, type: "flow", channel: "whatsapp", serverAt: recently() }];
    optedOut = new Set();
    reserved = new Set();
    secrets.on(GetSecretValueCommand).resolves({ SecretString: "k" });
    s3.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => PDF } } as never);
    let media = 0;
    messaging.on(PostWhatsAppMessageMediaCommand).callsFake(() => ({ mediaId: `media-${++media}` }));
    let out = 0;
    messaging.on(SendWhatsAppMessageCommand).callsFake(() => ({ messageId: `out-${++out}` }));
    sms.on(SendRcsMessageCommand).resolves({ MessageId: "rcs-1" });
    dynamo.on(GetCommand).callsFake((input: { Key: { pk: string; sk: string } }) => {
      const { pk, sk } = input.Key;
      if (pk === "LOAD#L1" && sk === "META") return { Item: load };
      if (pk === "LOAD#L1" && sk === "CLAIM") return { Item: claim };
      if (pk === "LOAD#L1" && sk.startsWith("PACK#")) return { Item: { digest: "c47e0e473434a54d", amountUsd: 17.28 } };
      if (pk.startsWith("OPTOUT#") && optedOut.has(pk.slice(7))) return { Item: { pk } };
      return {};
    });
    dynamo.on(QueryCommand).callsFake(() => ({ Items: [...events].reverse() }));
    dynamo.on(PutCommand).resolves({});
    dynamo.on(UpdateCommand).callsFake((input: { Key: { sk: string }; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string> }) => {
      const name = input.ExpressionAttributeNames?.["#r"];
      if (input.Key.sk === "CLAIM" && name && input.ConditionExpression?.includes("attribute_not_exists(#r)")) {
        if (reserved.has(name)) throw Object.assign(new Error("taken"), { name: "ConditionalCheckFailedException" });
        reserved.add(name);
      }
      return {};
    });
  });

  it("uploads the stored PDF from S3 once, then sends it as a document to the dispatcher and to a driver whose window is open", async () => {
    const results = await sendClaimReceipts(load);
    expect(results).toEqual([
      { audience: "dispatcher", channel: "whatsapp", sent: true },
      { audience: "driver", channel: "whatsapp", sent: true },
    ]);
    const uploads = messaging.commandCalls(PostWhatsAppMessageMediaCommand).map((c) => c.args[0].input);
    expect(uploads).toEqual([{ originationPhoneNumberId: "phone-number-id-test", sourceS3File: { bucketName: "evidence-bucket", key: "packs/L1/claim.pdf" } }]);
    // One upload, then one send per recipient naming the same media id.
    expect(messaging.calls().map((c) => (c.args[0] as { constructor: { name: string } }).constructor.name)).toEqual([
      "PostWhatsAppMessageMediaCommand",
      "SendWhatsAppMessageCommand",
      "SendWhatsAppMessageCommand",
    ]);
    const sent = whatsappSent();
    expect(sent.map((m) => m.to)).toEqual([DISPATCHER, DRIVER]);
    expect(sent[0]).toMatchObject({ type: "document", document: { id: "media-1", filename: "detention-claim-L1.pdf", caption: "Claim summary for load L1: $17.28. The signed evidence pack went with the claim email." } });
    expect(sent[1]!.document!.id).toBe("media-1");
    // The file was read once, for its hash.
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(1);
    expect(messaging.commandCalls(SendWhatsAppMessageCommand)[0]!.args[0].input.metaApiVersion).toBe("v23.0");
    // Each send is recorded on the load with the file name, the caption and the PDF's hash.
    const rows = records();
    expect(rows.map((r) => r.audience)).toEqual(["dispatcher", "driver"]);
    for (const r of rows) {
      expect(r.status).toBeUndefined();
      expect(r.message).toEqual({ kind: "document", text: expect.stringContaining("Claim summary for load L1"), document: { filename: "detention-claim-L1.pdf", sha256: PDF_SHA } });
      expect(JSON.stringify(r)).not.toMatch(/packs\/|media-\d/);
    }
  });

  it("sends the judge's own copy only, on a DEMO load, in their language", async () => {
    load = baseLoad({ demo: true, language: "es_MX", ws: "demo" });
    expect(await sendClaimReceipts(load)).toEqual([{ audience: "driver", channel: "whatsapp", sent: true }]);
    const sent = whatsappSent();
    expect(sent.map((m) => m.to)).toEqual([DRIVER]);
    expect(sent[0]!.document!.caption).toBe(RECEIPT_TEXT.es_MX.caption("L1", "$17.28"));
  });

  it("keeps every gate: a test number gets no upload and is recorded as not sent", async () => {
    load = baseLoad({ demo: true, address: { kind: "phone", e164: STRANGER } });
    expect(await sendClaimReceipts(load)).toEqual([{ audience: "driver", channel: "whatsapp", sent: false }]);
    expect(messaging.calls()).toHaveLength(0);
    const [row] = records();
    expect(row).toMatchObject({ status: "not_sent", notSentReason: NOT_SENT.notAllowlisted, message: { kind: "document", document: { filename: "detention-claim-L1.pdf", sha256: PDF_SHA } } });
  });

  it("never sends to someone who replied STOP", async () => {
    optedOut.add("phone:driver");
    await sendClaimReceipts(load);
    expect(whatsappSent().map((m) => m.to)).toEqual([DISPATCHER]);
    expect(records().find((r) => r.audience === "driver")).toMatchObject({ status: "not_sent", notSentReason: NOT_SENT.optedOut });
  });

  it("sends nothing while driver replies are switched off", async () => {
    process.env.DRIVER_REPLIES = "off";
    try {
      await sendClaimReceipts(load);
    } finally {
      process.env.DRIVER_REPLIES = "on";
    }
    expect(messaging.calls()).toHaveLength(0);
    expect(records().map((r) => r.notSentReason)).toEqual([NOT_SENT.repliesOff, NOT_SENT.repliesOff]);
  });

  it("leaves out a carrier driver whose 24-hour window has closed, and says why", async () => {
    events = [{ type: "flow", channel: "whatsapp", serverAt: longAgo() }];
    await sendClaimReceipts(load);
    expect(whatsappSent().map((m) => m.to)).toEqual([DISPATCHER]);
    expect(records().find((r) => r.audience === "driver")).toMatchObject({ status: "not_sent", notSentReason: NOT_SENT.windowClosed });
    expect(windowOpen(null)).toBe(false);
    expect(windowOpen(new Date(Date.now() - 23 * 60 * 60_000).toISOString())).toBe(true);
    // RCS replies and failover records do not open a WhatsApp window.
    events = [{ type: "flow", channel: "whatsapp", serverAt: longAgo() }, { type: "text", channel: "rcs", serverAt: recently() }, { type: "failover", channel: "rcs", serverAt: recently() }];
    dynamo.resetHistory();
    reserved.clear();
    await sendClaimReceipts(load);
    expect(records().find((r) => r.audience === "driver")).toMatchObject({ notSentReason: NOT_SENT.windowClosed });
  });

  it("does not page the dispatcher for a test load unless the test asks", async () => {
    load = baseLoad({ synthetic: true });
    await sendClaimReceipts(load);
    expect(records().find((r) => r.audience === "dispatcher")).toMatchObject({ status: "not_sent", notSentReason: NOT_SENT.testLoad });
    expect(whatsappSent().map((m) => m.to)).toEqual([DRIVER]);
  });

  it("records a failed upload as not sent, sends no document and carries on to the next recipient", async () => {
    messaging.on(PostWhatsAppMessageMediaCommand).rejectsOnce(Object.assign(new Error("boom"), { name: "ValidationException" })).resolves({ mediaId: "media-9" });
    const results = await sendClaimReceipts(load);
    expect(results).toEqual([
      { audience: "dispatcher", channel: "whatsapp", sent: false },
      { audience: "driver", channel: "whatsapp", sent: true },
    ]);
    expect(whatsappSent().map((m) => m.to)).toEqual([DRIVER]);
    expect(records()[0]).toMatchObject({ audience: "dispatcher", status: "not_sent", notSentReason: NOT_SENT.uploadFailed });
  });

  it("records a refused document send as not sent without throwing", async () => {
    messaging.on(SendWhatsAppMessageCommand).rejects(Object.assign(new Error("no"), { name: "AccessDeniedByMetaException" }));
    expect((await sendClaimReceipts(load)).every((r) => !r.sent)).toBe(true);
    expect(records().map((r) => r.notSentReason)).toEqual([NOT_SENT.sendFailed, NOT_SENT.sendFailed]);
  });

  it("records a missing PDF as not sent, with no upload", async () => {
    claim = { ...claim, pdfKey: undefined };
    await sendClaimReceipts(load);
    expect(messaging.calls()).toHaveLength(0);
    expect(records().map((r) => r.notSentReason)).toEqual([NOT_SENT.noPdf, NOT_SENT.noPdf]);
  });

  it("sends nothing before the claim record says sent", async () => {
    claim = { ...claim, status: "sending" };
    expect(await sendClaimReceipts(load)).toEqual([]);
    expect(messaging.calls()).toHaveLength(0);
  });

  it("gives an RCS driver the amount and the console link instead of a file", async () => {
    load = baseLoad({ demo: true, channel: "rcs", ws: "demo" });
    expect(await sendClaimReceipts(load)).toEqual([{ audience: "driver", channel: "rcs", sent: true }]);
    expect(messaging.commandCalls(PostWhatsAppMessageMediaCommand)).toHaveLength(0);
    const body = sms.commandCalls(SendRcsMessageCommand)[0]!.args[0].input.RcsMessageContent?.Content?.TextMessage?.Body;
    expect(body).toBe("Claim summary for load L1: $17.28. See the claim and its evidence: https://d3djuoqhg6b8o2.cloudfront.net/loads/L1");
    expect(records()[0]).toMatchObject({ channel: "rcs", message: { kind: "text" } });
  });

  it("skips the RCS link for a load with no console page, but still sends the dispatcher's file", async () => {
    load = baseLoad({ channel: "rcs" });
    expect(await sendClaimReceipts(load)).toEqual([{ audience: "dispatcher", channel: "whatsapp", sent: true }]);
    expect(sms.calls()).toHaveLength(0);
  });

  it("runs from the filed outcome step after the driver's text, and a failed text still lets the PDF go", async () => {
    const told = await tellOutcome({ kind: "filed", loadId: "L1" });
    expect(told.sent).toBe(true);
    expect(told.receipts?.map((r) => r.sent)).toEqual([true, true]);
    expect(whatsappSent().map((m) => m.type)).toEqual(["text", "document", "document"]);

    messaging.reset();
    reserved.clear();
    messaging.on(SendWhatsAppMessageCommand).rejectsOnce(Object.assign(new Error("down"), { name: "ThrottlingException" })).resolves({ messageId: "out-x" });
    messaging.on(PostWhatsAppMessageMediaCommand).resolves({ mediaId: "media-x" });
    await expect(tellOutcome({ kind: "filed", loadId: "L1" })).rejects.toThrow("down");
    expect(messaging.commandCalls(PostWhatsAppMessageMediaCommand)).toHaveLength(1);
    expect(whatsappSent().map((m) => m.type)).toEqual(["text", "document", "document"]);
  });

  it("sends each recipient's PDF once: a retry of the outcome step after the PDF went sends no second copy", async () => {
    messaging.on(SendWhatsAppMessageCommand).rejectsOnce(Object.assign(new Error("down"), { name: "ThrottlingException" })).resolves({ messageId: "out-x" });
    await expect(tellOutcome({ kind: "filed", loadId: "L1" })).rejects.toThrow("down");
    expect(whatsappSent().filter((m) => m.type === "document").map((m) => m.to)).toEqual([DISPATCHER, DRIVER]);
    // Step Functions retries the step: the text goes, the PDF does not go again.
    messaging.reset();
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-y" });
    messaging.on(PostWhatsAppMessageMediaCommand).resolves({ mediaId: "media-y" });
    dynamo.resetHistory();
    const retried = await tellOutcome({ kind: "filed", loadId: "L1" });
    expect(retried.sent).toBe(true);
    expect(whatsappSent().map((m) => m.type)).toEqual(["text"]);
    expect(messaging.commandCalls(PostWhatsAppMessageMediaCommand)).toHaveLength(0);
    expect(retried.receipts).toEqual([
      { audience: "dispatcher", channel: "whatsapp", sent: false, skipped: ALREADY_HANDLED },
      { audience: "driver", channel: "whatsapp", sent: false, skipped: ALREADY_HANDLED },
    ]);
    // No second not-sent row either: the console shows the one real send per recipient.
    expect(records()).toEqual([]);
  });

  it("uses the PDF hash recorded at filing instead of reading the file again", async () => {
    claim = { ...claim, pdfSha256: "c".repeat(64) };
    await sendClaimReceipts(load);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(records().map((r) => (r.message as { document?: { sha256?: string } }).document?.sha256)).toEqual(["c".repeat(64), "c".repeat(64)]);
  });

  it("records a send that throws as not sent and carries on to the next recipient", async () => {
    // The opt-out check cannot be read, so each send throws before any message goes.
    dynamo.on(GetCommand).callsFake((input: { Key: { pk: string; sk: string } }) => {
      if (input.Key.pk.startsWith("OPTOUT#")) throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
      if (input.Key.sk === "CLAIM") return { Item: claim };
      return {};
    });
    const results = await sendClaimReceipts(load);
    expect(results.map((r) => [r.audience, r.sent])).toEqual([["dispatcher", false], ["driver", false]]);
    expect(messaging.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
    expect(records().map((r) => [r.audience, r.status, r.notSentReason])).toEqual([["dispatcher", "not_sent", NOT_SENT.failed], ["driver", "not_sent", NOT_SENT.failed]]);
    expect(records()[0]!.message).toEqual({ kind: "document", text: expect.stringContaining("Claim summary for load L1"), document: { filename: "detention-claim-L1.pdf", sha256: PDF_SHA } });
  });

  it("never sends the PDF after the verdict message", async () => {
    await tellOutcome({ kind: "verdict", loadId: "L1", verdict: "BILLABLE", amountUsd: 17.28, reasons: [] });
    expect(messaging.commandCalls(PostWhatsAppMessageMediaCommand)).toHaveLength(0);
  });

  it("keeps the caption and the RCS text short and free of internal terms in every language", () => {
    const link = "https://d3djuoqhg6b8o2.cloudfront.net/loads/LIVE-mvheu9rl";
    for (const language of LANGUAGES) {
      const caption = RECEIPT_TEXT[language].caption("LIVE-mvheu9rl", "$1234.56");
      const rcs = RECEIPT_TEXT[language].rcsLink("LIVE-mvheu9rl", "$1234.56", link);
      // WhatsApp shows a document caption under the file; 1,024 characters is Meta's limit.
      expect(caption.length, language).toBeLessThanOrEqual(160);
      expect(rcs.length, language).toBeLessThanOrEqual(320);
      for (const text of [caption, rcs]) expect(text, language).not.toMatch(/S3|SEND#|wamid|digest|sha|lambda|pack id|claim_receipt/i);
    }
  });
});
