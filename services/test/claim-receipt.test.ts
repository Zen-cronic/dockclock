import { createHash } from "node:crypto";
import { PinpointSMSVoiceV2Client, SendRcsMessageCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { PostWhatsAppMessageMediaCommand, SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LANGUAGES } from "../src/messages.js";
import { NOT_SENT } from "../src/outbound.js";
import { handler as tellOutcome } from "../src/outcome.js";
import { ALREADY_HANDLED, RECEIPT_TEXT, SEND_UNCONFIRMED, sameRecipient, sendClaimReceipts, windowOpen } from "../src/claim-receipt.js";
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
// Receipt reservations taken on the CLAIM record (attribute names), as DynamoDB would keep them,
// and the not-sent row a released reservation left behind (attribute name -> the row's sort key).
let reserved: Set<string>;
let leftRows: Map<string, string>;
// A role's share of another role's send (attribute name -> the role it shared).
let shares: Map<string, unknown>;

type Update = { Key: { sk: string }; UpdateExpression?: string; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> };
// Takes and releases reservations on the CLAIM record, as DynamoDB's conditions would: #r0 (and
// #r1 for a role sharing the send), each with its left row's key #n0/#n1 and a share #s1.
function reservations(input: Update) {
  const named = input.ExpressionAttributeNames ?? {};
  const roles = [0, 1].filter((i) => named[`#r${i}`]).map((i) => ({ name: named[`#r${i}`]!, left: named[`#n${i}`], share: named[`#s${i}`], i }));
  if (input.Key.sk !== "CLAIM" || !roles.length) return {};
  if (input.ConditionExpression?.includes("attribute_not_exists(#r0)")) {
    if (roles.some((r) => reserved.has(r.name))) throw Object.assign(new Error("taken"), { name: "ConditionalCheckFailedException" });
    const old: Record<string, string> = {};
    for (const r of roles) {
      reserved.add(r.name);
      if (r.share) shares.set(r.share, input.ExpressionAttributeValues?.[":a"]);
      const sk = r.left ? leftRows.get(r.left) : undefined;
      if (r.left && sk) old[r.left] = sk;
      if (r.left) leftRows.delete(r.left);
    }
    return { Attributes: old };
  }
  if (input.UpdateExpression?.startsWith("REMOVE")) {
    for (const r of roles) {
      reserved.delete(r.name);
      if (r.share) shares.delete(r.share);
      const sk = input.ExpressionAttributeValues?.[`:n${r.i}`];
      if (r.left && typeof sk === "string") leftRows.set(r.left, sk);
    }
  }
  return {};
}

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
// The receipt rows still on the load: every row written, less the ones deleted.
const kept = () => {
  const gone = new Set(dynamo.commandCalls(DeleteCommand).map((c) => String(c.args[0].input.Key?.sk)));
  return records().filter((r) => !gone.has(String(r.sk)));
};
const fail = (name: string) => Object.assign(new Error(name), { name });

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
    leftRows = new Map();
    shares = new Map();
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
    dynamo.on(DeleteCommand).resolves({});
    dynamo.on(UpdateCommand).callsFake(reservations);
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

  it("records a failed upload as not sent, gives the reservation back and carries on to the next recipient", async () => {
    messaging.on(PostWhatsAppMessageMediaCommand).rejectsOnce(fail("ThrottlingException")).resolves({ mediaId: "media-9" });
    const results = await sendClaimReceipts(load);
    expect(results).toEqual([
      { audience: "dispatcher", channel: "whatsapp", sent: false, skipped: NOT_SENT.uploadFailed },
      { audience: "driver", channel: "whatsapp", sent: true },
    ]);
    expect(whatsappSent().map((m) => m.to)).toEqual([DRIVER]);
    expect(records()[0]).toMatchObject({ audience: "dispatcher", status: "not_sent", notSentReason: NOT_SENT.uploadFailed });
    expect([...reserved]).toEqual(["receiptDriverAt"]);
    // A retry of the outcome step sends the dispatcher's PDF, and the earlier not-sent row is gone.
    expect((await sendClaimReceipts(load)).map((r) => [r.audience, r.sent, r.skipped])).toEqual([["dispatcher", true, undefined], ["driver", false, ALREADY_HANDLED]]);
    expect(whatsappSent().map((m) => m.to)).toEqual([DRIVER, DISPATCHER]);
    expect(kept().map((r) => [r.audience, r.status ?? "sent"])).toEqual([["driver", "sent"], ["dispatcher", "sent"]]);
  });

  it("reads back only the reservation's own attributes when it reserves, not the whole claim", async () => {
    await sendClaimReceipts(load);
    const takes = dynamo.commandCalls(UpdateCommand).map((c) => c.args[0].input).filter((i) => i.ConditionExpression?.includes("attribute_not_exists(#r0)"));
    expect(takes).toHaveLength(2);
    for (const take of takes) expect(take.ReturnValues).toBe("UPDATED_OLD");
  });

  // The conversation keeps the latest recorded attempt's row: a retry replaces the earlier row only
  // when it records its own, and one that ends unconfirmed leaves it in place.
  it("keeps an earlier not-sent row until a retry records its own outcome", async () => {
    const dispatcherRows = () => kept().filter((r) => r.audience === "dispatcher").map((r) => r.notSentReason ?? "sent");
    // The upload fails for the first recipient of each run (the dispatcher).
    let uploads = 0;
    messaging.on(PostWhatsAppMessageMediaCommand).callsFake(() => {
      if (uploads++ === 0) throw fail("ThrottlingException");
      return { mediaId: "media-9" };
    });
    await sendClaimReceipts(load);
    expect(dispatcherRows()).toEqual([NOT_SENT.uploadFailed]);
    // A second passing failure: its own row replaces the first.
    uploads = 0;
    expect((await sendClaimReceipts(load))[0]).toMatchObject({ audience: "dispatcher", skipped: NOT_SENT.uploadFailed });
    expect(dispatcherRows()).toEqual([NOT_SENT.uploadFailed]);
    expect(records().filter((r) => r.audience === "dispatcher")).toHaveLength(2);
    // A retry whose send may have gone records nothing, so the earlier row stays.
    messaging.on(SendWhatsAppMessageCommand).rejects(fail("TimeoutError"));
    expect((await sendClaimReceipts(load))[0]).toMatchObject({ audience: "dispatcher", skipped: SEND_UNCONFIRMED });
    expect(dispatcherRows()).toEqual([NOT_SENT.uploadFailed]);
    expect(reserved.has("receiptDispatcherAt")).toBe(true);
  });

  // A not-sent row that fails to write records nothing, so the earlier row stays: for a gate inside
  // the send (replies off) and for an answer given here (a closed window). A PDF that went replaces
  // the earlier row even when its own row failed to write: "not sent" would no longer be true.
  it("keeps an earlier not-sent row when the retry's own row cannot be written", async () => {
    const rowsOf = (audience: string) => kept().filter((r) => r.audience === audience && !failedPuts.has(String(r.sk))).map((r) => r.notSentReason ?? "sent");
    const failedPuts = new Set<string>();
    const failPuts = (on: boolean) =>
      dynamo.on(PutCommand).callsFake((input: { Item: Record<string, unknown> }) => {
        if (!on || !String(input.Item.sk).startsWith("SEND#")) return {};
        failedPuts.add(String(input.Item.sk));
        throw fail("ProvisionedThroughputExceededException");
      });
    // Both uploads fail: each recipient's not-sent row is written and the reservation released.
    messaging.on(PostWhatsAppMessageMediaCommand).rejects(fail("ThrottlingException"));
    await sendClaimReceipts(load);
    expect([rowsOf("dispatcher"), rowsOf("driver")]).toEqual([[NOT_SENT.uploadFailed], [NOT_SENT.uploadFailed]]);
    expect(reserved.size).toBe(0);
    // The retry: replies are off for the dispatcher's gate, the driver's window has closed, and
    // neither not-sent row can be written.
    failPuts(true);
    events = [{ type: "flow", channel: "whatsapp", serverAt: longAgo() }];
    process.env.DRIVER_REPLIES = "off";
    try {
      expect((await sendClaimReceipts(load)).map((r) => [r.audience, r.sent, r.skipped])).toEqual([["dispatcher", false, undefined], ["driver", false, NOT_SENT.windowClosed]]);
    } finally {
      process.env.DRIVER_REPLIES = "on";
    }
    expect(dynamo.commandCalls(DeleteCommand)).toHaveLength(0);
    expect([rowsOf("dispatcher"), rowsOf("driver")]).toEqual([[NOT_SENT.uploadFailed], [NOT_SENT.uploadFailed]]);
  });

  it("replaces an earlier not-sent row once the PDF went, even when the sent row cannot be written", async () => {
    messaging.on(PostWhatsAppMessageMediaCommand).rejectsOnce(fail("ThrottlingException")).resolves({ mediaId: "media-9" });
    await sendClaimReceipts(load);
    const earlier = records().find((r) => r.audience === "dispatcher")!;
    expect(earlier).toMatchObject({ notSentReason: NOT_SENT.uploadFailed });
    dynamo.on(PutCommand).rejects(fail("ProvisionedThroughputExceededException"));
    expect((await sendClaimReceipts(load))[0]).toEqual({ audience: "dispatcher", channel: "whatsapp", sent: true });
    expect(dynamo.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key?.sk)).toEqual([earlier.sk]);
  });

  it("gives the reservation back when the stored PDF cannot be read, and a retry sends it", async () => {
    // Read once up front and again for the dispatcher: both fail. The driver's read succeeds.
    s3.on(GetObjectCommand).rejectsOnce(fail("SlowDown")).rejectsOnce(fail("SlowDown")).resolves({ Body: { transformToByteArray: async () => PDF } } as never);
    const results = await sendClaimReceipts(load);
    expect(results).toEqual([
      { audience: "dispatcher", channel: "whatsapp", sent: false, skipped: NOT_SENT.pdfUnreadable },
      { audience: "driver", channel: "whatsapp", sent: true },
    ]);
    expect(records()[0]).toMatchObject({ audience: "dispatcher", status: "not_sent", notSentReason: NOT_SENT.pdfUnreadable });
    expect(reserved.has("receiptDispatcherAt")).toBe(false);
    expect((await sendClaimReceipts(load))[0]).toEqual({ audience: "dispatcher", channel: "whatsapp", sent: true });
    expect(kept().filter((r) => r.status === "not_sent")).toEqual([]);
  });

  // The gates answer first: a recipient they stop gets their final not-sent row, kept, even while
  // the stored PDF cannot be read; only a recipient they let through finds the read failing.
  it("answers a gated recipient with the gate, not with a PDF read that failed", async () => {
    s3.on(GetObjectCommand).rejects(fail("SlowDown"));
    optedOut.add("phone:driver");
    expect(await sendClaimReceipts(load)).toEqual([
      { audience: "dispatcher", channel: "whatsapp", sent: false, skipped: NOT_SENT.pdfUnreadable },
      { audience: "driver", channel: "whatsapp", sent: false },
    ]);
    expect(records().map((r) => [r.audience, r.notSentReason])).toEqual([["dispatcher", NOT_SENT.pdfUnreadable], ["driver", NOT_SENT.optedOut]]);
    // The opted-out driver's answer is final; the dispatcher's read can be tried again.
    expect([...reserved]).toEqual(["receiptDriverAt"]);
    // Read once up front and once for the dispatcher; never for the driver the gates stopped.
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(2);
    expect(records()[1]!.message).toEqual({ kind: "document", text: expect.stringContaining("Claim summary for load L1"), document: { filename: "detention-claim-L1.pdf" } });
  });

  it("treats a throw during the WhatsApp document send as unconfirmed: no not-sent row, the reservation stays", async () => {
    messaging.on(SendWhatsAppMessageCommand).rejects(fail("TimeoutError"));
    expect(await sendClaimReceipts(load)).toEqual([
      { audience: "dispatcher", channel: "whatsapp", sent: false, skipped: SEND_UNCONFIRMED },
      { audience: "driver", channel: "whatsapp", sent: false, skipped: SEND_UNCONFIRMED },
    ]);
    expect(records()).toEqual([]);
    expect([...reserved].sort()).toEqual(["receiptDispatcherAt", "receiptDriverAt"]);
    // A retry sends no second copy of a PDF that may have gone.
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-z" });
    expect((await sendClaimReceipts(load)).map((r) => r.skipped)).toEqual([ALREADY_HANDLED, ALREADY_HANDLED]);
    expect(records()).toEqual([]);
  });

  // Nothing went when WhatsApp refused the send outright on its first try: one not-sent row, and the
  // reservation stays, since the same send would be refused again. Anything that may have gone is
  // unconfirmed: a timeout, a throttle, a 5xx, or a refusal after the SDK retried an earlier attempt.
  it.each([
    ["AccessDeniedByMetaException", 403, 1, NOT_SENT.sendRefused],
    ["ValidationException", 400, 1, NOT_SENT.sendRefused],
    ["InvalidParametersException", 400, undefined, NOT_SENT.sendRefused],
    ["ThrottledRequestException", 429, 3, SEND_UNCONFIRMED],
    ["InternalServiceException", 500, 3, SEND_UNCONFIRMED],
    ["ValidationException", 400, 2, SEND_UNCONFIRMED],
    ["TimeoutError", undefined, 1, SEND_UNCONFIRMED],
  ])("sorts a WhatsApp document send that threw %s (HTTP %s, attempt %s) as %s", async (name, status, attempts, skipped) => {
    messaging.on(SendWhatsAppMessageCommand).rejects(Object.assign(fail(name), { $metadata: { httpStatusCode: status, attempts } }));
    const refused = skipped === NOT_SENT.sendRefused;
    expect((await sendClaimReceipts(load)).map((r) => [r.audience, r.sent, r.skipped])).toEqual([["dispatcher", false, skipped], ["driver", false, skipped]]);
    expect(records().map((r) => [r.audience, r.notSentReason])).toEqual(refused ? [["dispatcher", NOT_SENT.sendRefused], ["driver", NOT_SENT.sendRefused]] : []);
    expect([...reserved].sort()).toEqual(["receiptDispatcherAt", "receiptDriverAt"]);
    // A retry sends nothing and adds no row: refused or maybe sent, the recipient is handled.
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-z" });
    expect((await sendClaimReceipts(load)).map((r) => r.skipped)).toEqual([ALREADY_HANDLED, ALREADY_HANDLED]);
    expect(records()).toHaveLength(refused ? 2 : 0);
  });

  it("treats a send reply without a message id as unconfirmed too", async () => {
    messaging.on(SendWhatsAppMessageCommand).resolves({});
    expect((await sendClaimReceipts(load)).map((r) => r.skipped)).toEqual([SEND_UNCONFIRMED, SEND_UNCONFIRMED]);
    expect(records()).toEqual([]);
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

  // One phone set as DISPATCHER_PHONE and allowlisted as the driver: one person in both roles.
  describe("when the dispatcher and the driver are one person", () => {
    let phone: string | undefined;
    beforeEach(() => {
      phone = process.env.DISPATCHER_PHONE;
      // The driver's number, written another way: the comparison is on the canonical E.164.
      process.env.DISPATCHER_PHONE = "(555) 010-0001";
    });
    afterEach(() => {
      process.env.DISPATCHER_PHONE = phone;
    });

    it("sends the PDF once, records one row, and records the driver as sharing the dispatcher's send", async () => {
      expect(await sendClaimReceipts(load)).toEqual([
        { audience: "dispatcher", channel: "whatsapp", sent: true },
        { audience: "driver", channel: "whatsapp", sent: true, sharedWith: "dispatcher" },
      ]);
      expect(messaging.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(1);
      expect(whatsappSent().map((m) => m.to)).toEqual([DRIVER]);
      expect(records().map((r) => [r.audience, r.status ?? "sent"])).toEqual([["dispatcher", "sent"]]);
      expect([...reserved].sort()).toEqual(["receiptDispatcherAt", "receiptDriverAt"]);
      expect(shares.get("receiptDriverSharedWith")).toBe("dispatcher");
    });

    it("shares the send even when the driver's own window has closed: the Approve tap opened it", async () => {
      events = [{ type: "flow", channel: "whatsapp", serverAt: longAgo() }];
      expect((await sendClaimReceipts(load)).map((r) => [r.audience, r.sent, r.skipped, r.sharedWith])).toEqual([
        ["dispatcher", true, undefined, undefined],
        ["driver", true, undefined, "dispatcher"],
      ]);
      expect(records().filter((r) => r.status === "not_sent")).toEqual([]);
    });

    it("sends nothing on a retry after the shared send", async () => {
      await sendClaimReceipts(load);
      messaging.resetHistory();
      dynamo.resetHistory();
      expect(await sendClaimReceipts(load)).toEqual([
        { audience: "dispatcher", channel: "whatsapp", sent: false, skipped: ALREADY_HANDLED },
        { audience: "driver", channel: "whatsapp", sent: false, skipped: ALREADY_HANDLED },
      ]);
      expect(messaging.calls()).toHaveLength(0);
      expect(records()).toEqual([]);
    });

    it("gives both reservations back after a passing failure before the send, and the retry sends once", async () => {
      messaging.on(PostWhatsAppMessageMediaCommand).rejectsOnce(fail("ThrottlingException")).resolves({ mediaId: "media-9" });
      expect(await sendClaimReceipts(load)).toEqual([
        { audience: "dispatcher", channel: "whatsapp", sent: false, skipped: NOT_SENT.uploadFailed },
        { audience: "driver", channel: "whatsapp", sent: false, skipped: NOT_SENT.uploadFailed, sharedWith: "dispatcher" },
      ]);
      expect(records().map((r) => [r.audience, r.notSentReason])).toEqual([["dispatcher", NOT_SENT.uploadFailed]]);
      expect(reserved.size).toBe(0);
      expect(shares.size).toBe(0);
      expect((await sendClaimReceipts(load)).map((r) => [r.audience, r.sent, r.sharedWith])).toEqual([["dispatcher", true, undefined], ["driver", true, "dispatcher"]]);
      expect(whatsappSent().map((m) => m.to)).toEqual([DRIVER]);
      // The retry's send replaces the first run's not-sent row: one row, sent.
      expect(kept().map((r) => [r.audience, r.status ?? "sent"])).toEqual([["dispatcher", "sent"]]);
    });

    it("keeps both reservations when the shared send may have gone, and a retry sends nothing", async () => {
      messaging.on(SendWhatsAppMessageCommand).rejects(fail("TimeoutError"));
      expect((await sendClaimReceipts(load)).map((r) => [r.audience, r.skipped])).toEqual([["dispatcher", SEND_UNCONFIRMED], ["driver", SEND_UNCONFIRMED]]);
      expect([...reserved].sort()).toEqual(["receiptDispatcherAt", "receiptDriverAt"]);
      messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-z" });
      expect((await sendClaimReceipts(load)).map((r) => r.skipped)).toEqual([ALREADY_HANDLED, ALREADY_HANDLED]);
      expect(messaging.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(1);
      expect(records()).toEqual([]);
    });

    it("sends the filed text and one PDF from the filed outcome step", async () => {
      await tellOutcome({ kind: "filed", loadId: "L1" });
      expect(whatsappSent().map((m) => m.type)).toEqual(["text", "document"]);
    });

    it("still sends the driver's own copy on a test load that does not ask dispatch", async () => {
      load = baseLoad({ synthetic: true });
      expect((await sendClaimReceipts(load)).map((r) => [r.audience, r.sent, r.skipped])).toEqual([["dispatcher", false, NOT_SENT.testLoad], ["driver", true, undefined]]);
      expect(whatsappSent().map((m) => m.to)).toEqual([DRIVER]);
    });

    it("sends both copies when the driver is known by a BSUID: nothing shows it is the dispatcher's phone", async () => {
      const allowlist = process.env.DRIVER_ALLOWLIST;
      process.env.DRIVER_ALLOWLIST = `${allowlist},bsuid-test-7`;
      try {
        load = baseLoad({ address: { kind: "bsuid", id: "bsuid-test-7" }, driverKey: "bsuid:bsuid-test-7" });
        expect(await sendClaimReceipts(load)).toEqual([
          { audience: "dispatcher", channel: "whatsapp", sent: true },
          { audience: "driver", channel: "whatsapp", sent: true },
        ]);
      } finally {
        process.env.DRIVER_ALLOWLIST = allowlist;
      }
      expect(messaging.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(2);
      expect(records().map((r) => r.audience)).toEqual(["dispatcher", "driver"]);
    });
  });

  it("sends each of two different phones its own copy, neither marked as shared", async () => {
    const results = await sendClaimReceipts(load);
    expect(results.map((r) => r.sharedWith)).toEqual([undefined, undefined]);
    expect(whatsappSent().map((m) => m.to)).toEqual([DISPATCHER, DRIVER]);
    expect(shares.size).toBe(0);
  });

  it("compares addresses by kind and canonical value", () => {
    expect(sameRecipient({ kind: "phone", e164: "+15550100001" }, { kind: "phone", e164: "1 (555) 010-0001" })).toBe(true);
    expect(sameRecipient({ kind: "phone", e164: "+15550100001" }, { kind: "phone", e164: "+15550100009" })).toBe(false);
    expect(sameRecipient({ kind: "bsuid", id: "bsuid-test-7" }, { kind: "bsuid", id: "bsuid-test-7" })).toBe(true);
    expect(sameRecipient({ kind: "phone", e164: "+15550100001" }, { kind: "bsuid", id: "+15550100001" })).toBe(false);
    expect(sameRecipient({ kind: "phone", e164: "+1555" }, { kind: "phone", e164: "+1555" })).toBe(false);
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

  it("records a setting no retry can fix once and keeps the reservation: no DISPATCHER_PHONE", async () => {
    const phone = process.env.DISPATCHER_PHONE;
    delete process.env.DISPATCHER_PHONE;
    try {
      expect(await sendClaimReceipts(load)).toEqual([
        { audience: "dispatcher", channel: "whatsapp", sent: false, skipped: NOT_SENT.noDispatcher },
        { audience: "driver", channel: "whatsapp", sent: true },
      ]);
      expect(reserved.has("receiptDispatcherAt")).toBe(true);
      // Every retry finds the recipient handled; the conversation keeps the one row.
      await sendClaimReceipts(load);
      await sendClaimReceipts(load);
    } finally {
      process.env.DISPATCHER_PHONE = phone;
    }
    expect(records().filter((r) => r.audience === "dispatcher").map((r) => r.notSentReason)).toEqual([NOT_SENT.noDispatcher]);
  });

  it("records an RCS receipt that this deployment cannot send once, and keeps the reservation", async () => {
    load = baseLoad({ demo: true, channel: "rcs", ws: "demo" });
    const agent = process.env.RCS_AGENT_ID;
    delete process.env.RCS_AGENT_ID;
    try {
      expect(await sendClaimReceipts(load)).toEqual([{ audience: "driver", channel: "rcs", sent: false, skipped: NOT_SENT.rcsOff }]);
      expect(await sendClaimReceipts(load)).toEqual([{ audience: "driver", channel: "rcs", sent: false, skipped: ALREADY_HANDLED }]);
    } finally {
      process.env.RCS_AGENT_ID = agent;
    }
    expect(sms.calls()).toHaveLength(0);
    expect(records().map((r) => [r.channel, r.notSentReason])).toEqual([["rcs", NOT_SENT.rcsOff]]);
  });

  it("records an address no channel can reach once: a bad number, or an RCS driver with no phone number", async () => {
    load = baseLoad({ demo: true, address: { kind: "phone", e164: "+1555" } });
    expect(await sendClaimReceipts(load)).toEqual([{ audience: "driver", channel: "whatsapp", sent: false, skipped: NOT_SENT.badNumber }]);
    expect(reserved.has("receiptDriverAt")).toBe(true);
    reserved.clear();
    dynamo.resetHistory();
    const allowlist = process.env.DRIVER_ALLOWLIST;
    process.env.DRIVER_ALLOWLIST = `${allowlist},bsuid-test-1`;
    try {
      load = baseLoad({ demo: true, channel: "rcs", ws: "demo", address: { kind: "bsuid", id: "bsuid-test-1" } });
      expect(await sendClaimReceipts(load)).toEqual([{ audience: "driver", channel: "rcs", sent: false, skipped: NOT_SENT.rcsNeedsPhone }]);
    } finally {
      process.env.DRIVER_ALLOWLIST = allowlist;
    }
    expect(reserved.has("receiptDriverAt")).toBe(true);
    expect(records().map((r) => r.notSentReason)).toEqual([NOT_SENT.rcsNeedsPhone]);
  });

  it("gives back the reservation when a throw came before the send, so a retry still sends the PDF", async () => {
    const throttled = () => Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
    dynamo.on(GetCommand).callsFake((input: { Key: { pk: string; sk: string } }) => {
      if (input.Key.pk.startsWith("OPTOUT#")) throw throttled();
      if (input.Key.sk === "CLAIM") return { Item: claim };
      return {};
    });
    await sendClaimReceipts(load);
    expect(messaging.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
    expect(reserved.size).toBe(0);
    // Step Functions retries the step once the table answers again: both PDFs go.
    dynamo.on(GetCommand).callsFake((input: { Key: { pk: string; sk: string } }) => (input.Key.sk === "CLAIM" ? { Item: claim } : {}));
    expect((await sendClaimReceipts(load)).map((r) => r.sent)).toEqual([true, true]);
    expect(whatsappSent().map((m) => m.to)).toEqual([DISPATCHER, DRIVER]);
    // The first run's not-sent rows are deleted by the retry, so each recipient shows one sent row.
    expect(kept().map((r) => [r.audience, r.status ?? "sent"])).toEqual([["dispatcher", "sent"], ["driver", "sent"]]);
  });

  it("counts an RCS link whose receipt row failed to write as sent, keeps the reservation and records no not-sent row", async () => {
    load = baseLoad({ demo: true, channel: "rcs", ws: "demo" });
    dynamo.on(UpdateCommand).callsFake((input: Update) => {
      if (input.Key.sk === "RECEIPT" || !input.ExpressionAttributeNames?.["#r0"]) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
      return reservations(input);
    });
    expect(await sendClaimReceipts(load)).toEqual([{ audience: "driver", channel: "rcs", sent: true }]);
    expect(sms.commandCalls(SendRcsMessageCommand)).toHaveLength(1);
    expect(records().filter((r) => r.status === "not_sent")).toEqual([]);
    expect(reserved.has("receiptDriverAt")).toBe(true);
    // A retry sends no second link.
    expect(await sendClaimReceipts(load)).toEqual([{ audience: "driver", channel: "rcs", sent: false, skipped: ALREADY_HANDLED }]);
    expect(sms.commandCalls(SendRcsMessageCommand)).toHaveLength(1);
  });

  it("keeps the reservation and records no not-sent row when the RCS send call itself throws", async () => {
    load = baseLoad({ demo: true, channel: "rcs", ws: "demo" });
    sms.on(SendRcsMessageCommand).rejects(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    expect(await sendClaimReceipts(load)).toEqual([{ audience: "driver", channel: "rcs", sent: false, skipped: SEND_UNCONFIRMED }]);
    expect(records()).toEqual([]);
    expect(reserved.has("receiptDriverAt")).toBe(true);
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
