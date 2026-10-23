import { createPublicKey } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "aws-lambda";
import { clauseById } from "@dockclock/clause-engine";
import { facilityById, isoToLocalClock, isoToLocalDateTime, KmsSigner, normalizeClock, registerFacility, sha256Hex, type Facility } from "@dockclock/evidence";
import { readBol, type BolReading } from "./bol-reader.js";
import { checkClaim, toCents, type ClaimRequest } from "./claim.js";
import { buildClaimMime, claimFactsOf, claimPdfName, claimSubject, type SealedPackView } from "./claim-email.js";
import { buildClaimPdf } from "./claim-pdf.js";

if (process.env.DEMO_FACILITY) registerFacility(JSON.parse(process.env.DEMO_FACILITY) as Facility);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const publicKeys = new Map<string, Promise<{ pem: string; spkiSha256: string }>>();

// The evidence key's public half, fetched once per key; its fingerprint goes in every claim PDF. A failed
// fetch is forgotten, so one transient KMS error does not break every later claim in this container.
export function publicKeyOf(keyId: string, fetchDer: (keyId: string) => Promise<Buffer> = (id) => new KmsSigner(id).publicKeyDer()): Promise<{ pem: string; spkiSha256: string }> {
  let key = publicKeys.get(keyId);
  if (!key) {
    key = fetchDer(keyId).then((der) => ({
      pem: createPublicKey({ key: der, format: "der", type: "spki" }).export({ format: "pem", type: "spki" }).toString(),
      spkiSha256: sha256Hex(der),
    }));
    key.catch(() => publicKeys.delete(keyId));
    publicKeys.set(keyId, key);
  }
  return key;
}
const ses = new SESv2Client({ maxAttempts: 3 });

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

const key = (loadId: string, sk: string) => ({ pk: `LOAD#${loadId}`, sk });

interface Photo {
  mediaId: string;
  mimeType: string;
  s3Key?: string;
  sha256?: string;
}

interface LoadMeta {
  loadId: string;
  phase: string;
  clauseId: string;
  facilityId: string;
  appointmentAt: string;
  arrived: { serverAt: string } | null;
  // The Released tap, which stops the dock clock; the release pin confirms it. Absent on older loads.
  releasedTap?: { serverAt: string } | null;
  released: { serverAt: string } | null;
  bol: { inTime: string | null; outTime: string | null; receiverSigned?: boolean; delayReason: string | null; photos: Photo[] } | null;
  bolReading?: BolReading & { page: number; model: string; readAt: string };
  sealedPackId?: string;
  verdict?: string;
  synthetic?: boolean;
  ws?: string;
}

interface PackItem {
  s3Key: string;
  digest: string;
  keyId: string;
  verdict: string;
  confidence: string;
}

interface SignedPackFile {
  pack: SealedPackView & { evaluation: { verdict: string; reasons: string[]; clockStartAt: string | null } };
}

async function item<T>(loadId: string, sk: string): Promise<T | null> {
  const out = await ddb.send(new GetCommand({ TableName: env("TABLE_NAME"), Key: key(loadId, sk), ConsistentRead: true }));
  return (out.Item as T | undefined) ?? null;
}

// The sealed pack file: its exact text (attached to the claim as is) and its parsed form.
async function packFile(pack: PackItem): Promise<{ json: string; signed: SignedPackFile }> {
  const object = await s3.send(new GetObjectCommand({ Bucket: env("EVIDENCE_BUCKET"), Key: pack.s3Key }));
  const json = await object.Body!.transformToString();
  return { json, signed: JSON.parse(json) as SignedPackFile };
}

async function signedPack(pack: PackItem): Promise<SignedPackFile> {
  return (await packFile(pack)).signed;
}

function minutesBetween(clockA: string | null, clockB: string | null): number | null {
  const a = normalizeClock(clockA);
  const b = normalizeClock(clockB);
  if (!a || !b) return null;
  const toMin = (c: string) => Number(c.slice(0, 2)) * 60 + Number(c.slice(3));
  const diff = Math.abs(toMin(a) - toMin(b));
  return Math.min(diff, 1440 - diff);
}

async function getLoadEvidence(input: { loadId: string }) {
  const load = await item<LoadMeta>(input.loadId, "META");
  if (!load) return { error: `no load ${input.loadId}` };
  const clause = clauseById(load.clauseId);
  const facility = facilityById(load.facilityId);
  // Local date, time and zone at the facility, then the UTC instant it came from.
  const local = (iso: string | undefined | null) => (iso ? `${isoToLocalDateTime(iso, facility.timeZone)} (UTC ${iso})` : null);
  const pack = load.sealedPackId ? await item<PackItem>(input.loadId, `PACK#${load.sealedPackId}`) : null;
  const evaluation = pack ? (await signedPack(pack)).pack.evaluation : null;
  const approval = await item<{ approvalId: string; approvedAt: string; approver: string }>(input.loadId, "APPROVAL");
  const claim = await item<{ sentAt?: string }>(input.loadId, "CLAIM");
  return {
    loadId: load.loadId,
    phase: load.phase,
    facility: { name: facility.name, timeZone: facility.timeZone },
    counterparty: { name: clause.counterparty, role: clause.role },
    clause: {
      freeTimeMinutes: clause.freeTimeMinutes,
      freeTimeStartsAt: clause.freeTimeAnchor,
      ratePerHourUsd: clause.ratePerHourUsd,
      noticeLeadMinutes: clause.noticeLeadMinutes,
      claimWindowHours: clause.claimWindowHours,
      capUsdPerOccurrence: clause.capUsdPerOccurrence,
    },
    appointment: local(load.appointmentAt),
    arrivedPin: local(load.arrived?.serverAt),
    releasedTap: load.releasedTap ? local(load.releasedTap.serverAt) : null,
    releasedPin: local(load.released?.serverAt),
    driverBolEntries: load.bol && {
      inTime: load.bol.inTime,
      outTime: load.bol.outTime,
      receiverSigned: load.bol.receiverSigned ?? false,
      delayReason: load.bol.delayReason,
      pages: load.bol.photos.length,
    },
    photoReading: load.bolReading ?? null,
    verdict: evaluation?.verdict ?? load.verdict ?? null,
    reasons: evaluation?.reasons ?? [],
    amountUsd: evaluation?.amountUsd ?? 0,
    amountCents: toCents(evaluation?.amountUsd ?? 0),
    detentionMinutes: evaluation?.detentionMinutes ?? 0,
    packId: load.sealedPackId ?? null,
    packDigest: pack?.digest ?? null,
    confidence: pack?.confidence ?? null,
    approval: approval && { approvalId: approval.approvalId, approvedAt: approval.approvedAt },
    claimSentAt: claim?.sentAt ?? null,
  };
}

async function readBillOfLading(input: { loadId: string; page?: number }) {
  const load = await item<LoadMeta>(input.loadId, "META");
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const photo = load?.bol?.photos[page - 1];
  if (!load || !photo?.s3Key) return { error: `no stored bill-of-lading photo for load ${input.loadId} page ${page}` };
  const object = await s3.send(new GetObjectCommand({ Bucket: env("MEDIA_BUCKET"), Key: photo.s3Key }));
  const image = await object.Body!.transformToByteArray();
  const model = env("BOL_MODEL_ID");
  const reading = await readBol(image, photo.mimeType, model);
  const recorded = { ...reading, page, model, readAt: new Date().toISOString() };
  await ddb.send(
    new UpdateCommand({ TableName: env("TABLE_NAME"), Key: key(input.loadId, "META"), UpdateExpression: "SET bolReading = :r", ExpressionAttributeValues: { ":r": recorded } }),
  );
  const facility = facilityById(load.facilityId);
  const pinClock = (iso: string | undefined) => (iso ? isoToLocalClock(iso, facility.timeZone) : null);
  return {
    reading: recorded,
    comparedWithDriverEntries: {
      inMinutesApart: minutesBetween(reading.inTime, load.bol?.inTime ?? null),
      outMinutesApart: minutesBetween(reading.outTime, load.bol?.outTime ?? null),
      signatureAgrees: reading.receiverSigned === (load.bol?.receiverSigned ?? false),
    },
    comparedWithPins: {
      inMinutesApart: minutesBetween(reading.inTime, pinClock(load.arrived?.serverAt)),
      // The out time is compared with the release: the Released tap where one was recorded.
      outMinutesApart: minutesBetween(reading.outTime, pinClock(load.releasedTap?.serverAt ?? load.released?.serverAt)),
    },
  };
}

function recipientFor(role: "shipper" | "broker"): string {
  return role === "broker" ? env("COUNTERPARTY_EMAIL_BROKER") : env("COUNTERPARTY_EMAIL_SHIPPER");
}

async function sendDetentionClaim(input: ClaimRequest) {
  const load = await item<LoadMeta>(input.loadId, "META");
  if (!load) return { refused: `no load ${input.loadId}` };
  const pack = load.sealedPackId ? await item<PackItem>(input.loadId, `PACK#${load.sealedPackId}`) : null;
  const file = pack ? await packFile(pack) : null;
  const evaluation = file?.signed.pack.evaluation ?? null;
  const [approval, prior] = await Promise.all([item<{ approvalId: string }>(input.loadId, "APPROVAL"), item<{ sentAt?: string }>(input.loadId, "CLAIM")]);
  const decision = checkClaim(input, {
    loadId: load.loadId,
    phase: load.phase,
    verdict: evaluation?.verdict ?? "NONE",
    amountCents: toCents(evaluation?.amountUsd ?? 0),
    packDigest: pack?.digest ?? "",
    packId: load.sealedPackId ?? "",
    approvalId: approval?.approvalId ?? null,
    alreadySentAt: prior?.sentAt ?? null,
  });
  if (!decision.ok || !pack || !file || !evaluation) return { refused: decision.ok ? "no sealed pack" : decision.reason };

  // Everything the email needs is resolved before the claim is reserved: between the reservation and
  // the SES call nothing may throw, or the reservation would block every retry.
  const clause = clauseById(load.clauseId);
  const to = recipientFor(clause.role);
  const publicKey = await publicKeyOf(pack.keyId);
  // One set of facts, from the sealed pack and the clause, feeds the email and the PDF alike.
  const issuedAt = new Date();
  const facts = claimFactsOf({
    loadId: load.loadId,
    workspace: load.ws,
    synthetic: load.synthetic === true,
    clause,
    facility: facilityById(load.facilityId),
    pack: file.signed.pack,
    packDigest: pack.digest,
    spkiSha256: publicKey.spkiSha256,
    issuedAt,
  });
  const from = env("CLAIMS_FROM_EMAIL");
  const pdf = await buildClaimPdf(facts, { from, issuedAt });
  const subject = claimSubject(facts);
  const raw = buildClaimMime({ from, to, replyTo: env("REPLY_TO_EMAIL"), date: issuedAt, facts, opening: input.body, pdf, packFileName: `${load.sealedPackId}.json`, packJson: file.json });
  const configurationSet = env("SES_CONFIGURATION_SET");
  // Reserve the claim before sending, so a retried tool call can never email the broker twice.
  try {
    await ddb.send(
      new PutCommand({
        TableName: env("TABLE_NAME"),
        Item: { ...key(load.loadId, "CLAIM"), status: "sending", amountUsd: evaluation.amountUsd, amountCents: toCents(evaluation.amountUsd), packDigest: pack.digest, recipientRole: clause.role, reservedAt: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") return { refused: "a claim for this load is already being sent or was sent" };
    throw error;
  }
  let sesMessageId: string | undefined;
  try {
    const out = await ses.send(
      new SendEmailCommand({
        Content: { Raw: { Data: Buffer.from(raw, "utf8") } },
        ConfigurationSetName: configurationSet,
        EmailTags: [
          { Name: "purpose", Value: "detention_claim" },
          { Name: "loadId", Value: load.loadId },
        ],
      }),
    );
    sesMessageId = out.MessageId;
  } catch (error) {
    // Only an SES failure frees the reservation. The send was not accepted, so a retry is safe.
    await ddb.send(new DeleteCommand({ TableName: env("TABLE_NAME"), Key: key(load.loadId, "CLAIM") }));
    throw error;
  }
  // From here the email is out. A failure to record it keeps the reservation, so no retry re-sends.
  const sentAt = new Date().toISOString();
  const [mimeKey, pdfKey] = await Promise.all([storeClaimFile(claimEmailKey(load.loadId), raw, "message/rfc822", load.loadId), storeClaimFile(claimPdfKey(load.loadId), pdf, "application/pdf", load.loadId)]);
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env("TABLE_NAME"),
        Key: key(load.loadId, "CLAIM"),
        UpdateExpression: `SET #s = :s, sentAt = :t, sesMessageId = :m, subject = :sub${mimeKey ? ", mimeKey = :k" : ""}${pdfKey ? ", pdfKey = :p, pdfName = :pn" : ""}`,
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "sent", ":t": sentAt, ":m": sesMessageId, ":sub": subject, ...(mimeKey ? { ":k": mimeKey } : {}), ...(pdfKey ? { ":p": pdfKey, ":pn": claimPdfName(load.loadId) } : {}) },
      }),
    );
  } catch (error) {
    console.log(JSON.stringify({ kind: "claim_sent_unrecorded", loadId: load.loadId, sesMessageId, error: (error as Error).name }));
  }
  console.log(JSON.stringify({ kind: "claim_sent", loadId: load.loadId, amountUsd: evaluation.amountUsd, sesMessageId }));
  return { sent: true, sentAt, sesMessageId, recipientRole: clause.role, amountUsd: evaluation.amountUsd };
}

// The claim email's exact bytes and its PDF, kept next to the load's packs under the same Object Lock
// retention. The email is already out, so a failure here is logged and returns null instead of throwing.
export const claimEmailKey = (loadId: string) => `packs/${loadId}/claim.eml`;
export const claimPdfKey = (loadId: string) => `packs/${loadId}/claim.pdf`;
async function storeClaimFile(objectKey: string, body: string | Uint8Array, contentType: string, loadId: string): Promise<string | null> {
  try {
    await s3.send(new PutObjectCommand({ Bucket: env("EVIDENCE_BUCKET"), Key: objectKey, Body: body, ContentType: contentType }));
    return objectKey;
  } catch (error) {
    console.log(JSON.stringify({ kind: "claim_file_unstored", loadId, objectKey, error: (error as Error).name }));
    return null;
  }
}

type ToolInput = Record<string, unknown>;

function toolName(context: Context): string {
  const custom = (context.clientContext as unknown as { custom?: Record<string, string>; Custom?: Record<string, string> } | undefined) ?? {};
  const full = custom.custom?.bedrockAgentCoreToolName ?? custom.Custom?.bedrockAgentCoreToolName ?? "";
  return full.includes("___") ? full.slice(full.indexOf("___") + 3) : full;
}

// AgentCore Gateway calls this with the tool's arguments as the event and the tool name in the
// client context. Every result is plain JSON the agent reads back.
export async function handler(event: ToolInput, context: Context): Promise<unknown> {
  const name = toolName(context);
  console.log(JSON.stringify({ kind: "tool_called", tool: name, loadId: event.loadId }));
  switch (name) {
    case "get_load_evidence":
      return getLoadEvidence(event as { loadId: string });
    case "read_bill_of_lading":
      return readBillOfLading(event as { loadId: string; page?: number });
    case "send_detention_claim":
      return sendDetentionClaim(event as unknown as ClaimRequest);
    default:
      return { error: `unknown tool ${name}` };
  }
}
