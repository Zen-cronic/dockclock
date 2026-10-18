import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "aws-lambda";
import { clauseById } from "@dockclock/clause-engine";
import { facilityById, isoToLocalClock, normalizeClock, registerFacility, type Facility } from "@dockclock/evidence";
import { readBol, type BolReading } from "./bol-reader.js";
import { buildClaimMime, checkClaim, formatUsd, type ClaimRequest } from "./claim.js";

if (process.env.DEMO_FACILITY) registerFacility(JSON.parse(process.env.DEMO_FACILITY) as Facility);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
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
  released: { serverAt: string } | null;
  bol: { inTime: string | null; outTime: string | null; receiverSigned?: boolean; delayReason: string | null; photos: Photo[] } | null;
  bolReading?: BolReading & { page: number; model: string; readAt: string };
  sealedPackId?: string;
  verdict?: string;
}

interface PackItem {
  s3Key: string;
  digest: string;
  keyId: string;
  verdict: string;
  confidence: string;
}

interface SignedPackFile {
  pack: { packId: string; evaluation: { verdict: string; reasons: string[]; amountUsd: number; detentionMinutes: number; billableMinutes: number; clockStartAt: string | null } };
}

async function item<T>(loadId: string, sk: string): Promise<T | null> {
  const out = await ddb.send(new GetCommand({ TableName: env("TABLE_NAME"), Key: key(loadId, sk), ConsistentRead: true }));
  return (out.Item as T | undefined) ?? null;
}

async function signedPack(pack: PackItem): Promise<SignedPackFile> {
  const object = await s3.send(new GetObjectCommand({ Bucket: env("EVIDENCE_BUCKET"), Key: pack.s3Key }));
  return JSON.parse(await object.Body!.transformToString()) as SignedPackFile;
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
  const local = (iso: string | undefined | null) => (iso ? `${isoToLocalClock(iso, facility.timeZone)} (${iso})` : null);
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
      outMinutesApart: minutesBetween(reading.outTime, pinClock(load.released?.serverAt)),
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
  const evaluation = pack ? (await signedPack(pack)).pack.evaluation : null;
  const approval = await item<{ approvalId: string }>(input.loadId, "APPROVAL");
  const prior = await item<{ sentAt?: string }>(input.loadId, "CLAIM");
  const decision = checkClaim(input, {
    loadId: load.loadId,
    phase: load.phase,
    verdict: evaluation?.verdict ?? "NONE",
    amountUsd: evaluation?.amountUsd ?? 0,
    packDigest: pack?.digest ?? "",
    packId: load.sealedPackId ?? "",
    approvalId: approval?.approvalId ?? null,
    alreadySentAt: prior?.sentAt ?? null,
  });
  if (!decision.ok || !pack || !evaluation) return { refused: decision.ok ? "no sealed pack" : decision.reason };

  const clause = clauseById(load.clauseId);
  const to = recipientFor(clause.role);
  // Reserve the claim before sending, so a retried tool call can never email the broker twice.
  try {
    await ddb.send(
      new PutCommand({
        TableName: env("TABLE_NAME"),
        Item: { ...key(load.loadId, "CLAIM"), status: "sending", amountUsd: evaluation.amountUsd, packDigest: pack.digest, recipientRole: clause.role, reservedAt: new Date().toISOString() },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") return { refused: "a claim for this load is already being sent or was sent" };
    throw error;
  }
  const packFile = await s3.send(new GetObjectCommand({ Bucket: env("EVIDENCE_BUCKET"), Key: pack.s3Key }));
  const packJson = await packFile.Body!.transformToString();
  const footer = [
    "--",
    `Evidence pack ${load.sealedPackId} (sha256 ${pack.digest}) is attached.`,
    `It is signed with AWS KMS key ${pack.keyId} (ECDSA P-256). Verify the signature with that key's public key before relying on it.`,
    `Contract amount: ${formatUsd(evaluation.amountUsd)}, computed by the clause engine, not by the agent.`,
    "Sent by DockClock on behalf of the carrier. Reply to this email to dispute.",
  ].join("\n");
  try {
    const raw = buildClaimMime({ from: env("CLAIMS_FROM_EMAIL"), to, subject: input.subject, body: input.body, packFileName: `${load.sealedPackId}.json`, packJson, footer });
    const out = await ses.send(
      new SendEmailCommand({
        Content: { Raw: { Data: Buffer.from(raw, "utf8") } },
        ConfigurationSetName: env("SES_CONFIGURATION_SET"),
        EmailTags: [{ Name: "purpose", Value: "detention_claim" }],
      }),
    );
    const sentAt = new Date().toISOString();
    await ddb.send(
      new UpdateCommand({
        TableName: env("TABLE_NAME"),
        Key: key(load.loadId, "CLAIM"),
        UpdateExpression: "SET #s = :s, sentAt = :t, sesMessageId = :m, subject = :sub",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "sent", ":t": sentAt, ":m": out.MessageId, ":sub": input.subject },
      }),
    );
    console.log(JSON.stringify({ kind: "claim_sent", loadId: load.loadId, amountUsd: evaluation.amountUsd, sesMessageId: out.MessageId }));
    return { sent: true, sentAt, sesMessageId: out.MessageId, recipientRole: clause.role, amountUsd: evaluation.amountUsd };
  } catch (error) {
    await ddb.send(new DeleteCommand({ TableName: env("TABLE_NAME"), Key: key(load.loadId, "CLAIM") }));
    throw error;
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
