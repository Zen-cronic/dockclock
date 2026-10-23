import { CopyObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { clauseById, evaluate } from "@dockclock/clause-engine";
import {
  buildPack,
  corroborate,
  facilityById,
  isoToLocalClock,
  KmsSigner,
  localClockToIso,
  normalizeClock,
  packDigest,
  sealPack,
  toLoadEvidence,
  type BolCapture,
  type LoadRecord,
  type PinEvent,
  type TapEvent,
} from "@dockclock/evidence";
import type { BolRecord, PinRecord, TapRecord } from "./lifecycle.js";
import { ddb, getLoad, type LoadItem } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const s3 = new S3Client({});
const RETENTION_DAYS = 30;

function pinEvent(kind: PinEvent["kind"], pin: PinRecord | null, load: LoadItem): PinEvent | null {
  return pin && { kind, channel: pin.channel ?? load.channel, messageId: pin.messageId, serverAt: pin.serverAt, location: [pin.lon, pin.lat] };
}

function tapEvent(tap: TapRecord | null | undefined, load: LoadItem): TapEvent | null {
  return tap ? { channel: tap.channel ?? load.channel, messageId: tap.messageId, serverAt: tap.serverAt } : null;
}

// When the truck was released: the Released tap where one was recorded, else (older loads) the pin.
// The Flow pre-fills this as the out time, and the paper's out time is pinned to its date.
export function releaseTime(load: Pick<LoadItem, "releasedTap" | "released">): string | undefined {
  return load.releasedTap?.serverAt ?? load.released?.serverAt;
}

interface RecordedReading {
  legible: boolean;
  inTime: string | null;
  outTime: string | null;
  receiverSigned: boolean;
}

// The claims agent's reading of the photo, if it ran before sealing, with its times pinned to instants.
function photoReadingOf(load: LoadItem, timeZone: string): Pick<BolCapture, "photoReading"> {
  const reading = (load as unknown as { bolReading?: RecordedReading }).bolReading;
  if (!reading) return {};
  return {
    photoReading: {
      legible: reading.legible,
      checkIn: localClockToIso(reading.inTime, load.arrived?.serverAt ?? load.bol?.serverAt ?? new Date().toISOString(), timeZone),
      checkOut: localClockToIso(reading.outTime, releaseTime(load) ?? load.bol?.serverAt ?? new Date().toISOString(), timeZone),
      receiverSigned: reading.receiverSigned,
    },
  };
}

// Paperwork times are wall-clock at the facility; each is pinned to the day of the matching event
// (arrival pin, release). A time is "edited" only if it differs from the value the Flow pre-filled.
function bolCapture(bol: BolRecord | null, load: LoadItem, timeZone: string): BolCapture | null {
  if (!bol) return null;
  if (bol.channel === "rcs") {
    // A photo reply: nothing the driver typed or ticked, and no way to know it came from the camera.
    return {
      channel: "rcs",
      messageId: bol.messageId,
      serverAt: bol.serverAt,
      cameraOnly: false,
      pageSha256s: bol.photos.map((p) => p.sha256 ?? null),
      timesEdited: { in: false, out: false },
      signed: false,
      checkIn: null,
      checkOut: null,
      confirmedByDriver: false,
    };
  }
  const prefilled = (pinAt: string | undefined) => (pinAt ? isoToLocalClock(pinAt, timeZone) : null);
  return {
    channel: bol.channel ?? load.channel,
    messageId: bol.messageId,
    serverAt: bol.serverAt,
    cameraOnly: true,
    pageSha256s: bol.photos.map((p) => p.sha256 ?? null),
    timesEdited: {
      in: normalizeClock(bol.inTime) !== prefilled(load.arrived?.serverAt),
      out: normalizeClock(bol.outTime) !== prefilled(releaseTime(load)),
    },
    ...photoReadingOf(load, timeZone),
    // Only the receiver-signed box counts as a signature, never text typed into a name field.
    signed: bol.receiverSigned === true,
    checkIn: localClockToIso(bol.inTime, load.arrived?.serverAt ?? bol.serverAt, timeZone),
    checkOut: localClockToIso(bol.outTime, releaseTime(load) ?? bol.serverAt, timeZone),
    confirmedByDriver: true,
  };
}

export function toRecord(load: LoadItem): LoadRecord {
  const facility = facilityById(load.facilityId);
  return {
    loadId: load.loadId,
    clauseId: load.clauseId,
    facility,
    appointmentAt: load.appointmentAt,
    arrived: pinEvent("arrived", load.arrived, load),
    releasedTap: tapEvent(load.releasedTap, load),
    released: pinEvent("released", load.released, load),
    bol: bolCapture(load.bol ?? null, load, facility.timeZone),
    status214: false,
    // Only a notice SES accepted counts; its delivery time comes from the SES delivery event.
    notice: load.notice?.sentAt && load.notice.messageId ? { sentAt: load.notice.sentAt, deliveredAt: load.notice.deliveredAt ?? null, messageId: load.notice.messageId } : null,
    shipperConfirmation: null,
  };
}

export interface SealOutput {
  packId: string;
  s3Key: string;
  digest: string;
  verdict: string;
  confidence: string;
  amountUsd: number;
  reasons: string[];
}

// Evaluates the load against its clause, signs the pack with the KMS key, and writes it to the
// Object Lock bucket so it cannot be changed or deleted during the retention window. Sealing is
// once per load: a retried or redriven execution returns the pack that already exists.
export async function handler(input: { loadId: string }): Promise<SealOutput> {
  const load = await getLoad(input.loadId);
  if (!load) throw new Error(`load ${input.loadId} missing`);
  if (load.sealedPackId) {
    const existing = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.pack(load.loadId, load.sealedPackId) }));
    const item = existing.Item as (SealOutput & { s3Key: string }) | undefined;
    if (item) {
      log("pack_already_sealed", { loadId: load.loadId, packId: load.sealedPackId });
      return { packId: load.sealedPackId, s3Key: item.s3Key, digest: item.digest, verdict: item.verdict, confidence: item.confidence, amountUsd: item.amountUsd ?? 0, reasons: item.reasons ?? [] };
    }
  }
  const sealedAt = new Date().toISOString();
  const record = toRecord(load);
  const evaluation = evaluate(toLoadEvidence(record, sealedAt), clauseById(load.clauseId));
  const corroboration = corroborate(record);
  const pack = buildPack(record, corroboration, evaluation, sealedAt);
  const signed = await sealPack(pack, new KmsSigner(env.keyId()));
  const s3Key = `packs/${load.loadId}/${pack.packId}.json`;
  const retainUntil = new Date(Date.now() + RETENTION_DAYS * 86_400_000);
  // The stored photos go under the same lock as the pack that carries their hashes.
  for (const [index, photo] of (load.bol?.photos ?? []).entries()) {
    if (!photo.s3Key) continue;
    await s3.send(
      new CopyObjectCommand({
        Bucket: env.bucket(),
        Key: `packs/${load.loadId}/bol-${index + 1}-${photo.sha256?.slice(0, 12) ?? "unhashed"}`,
        CopySource: `${env.mediaBucket()}/${encodeURIComponent(photo.s3Key).replace(/%2F/g, "/")}`,
        ChecksumAlgorithm: "SHA256",
        ObjectLockMode: "GOVERNANCE",
        ObjectLockRetainUntilDate: retainUntil,
      }),
    );
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: env.bucket(),
      Key: s3Key,
      Body: JSON.stringify(signed),
      ContentType: "application/json",
      ChecksumAlgorithm: "SHA256",
      ObjectLockMode: "GOVERNANCE",
      ObjectLockRetainUntilDate: retainUntil,
    }),
  );
  const digest = packDigest(pack);
  await ddb.send(
    new PutCommand({
      TableName: env.table(),
      Item: { ...keys.pack(load.loadId, pack.packId), s3Key, digest, keyId: signed.keyId, verdict: evaluation.verdict, confidence: corroboration.confidence, amountUsd: evaluation.amountUsd, reasons: evaluation.reasons, sealedAt },
    }),
  );
  await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.load(load.loadId),
      // The load becomes terminal here, so later taps and Flows are refused instead of "saved".
      UpdateExpression: "SET sealedPackId = :p, verdict = :v, phase = :s, sealedAt = :t",
      ConditionExpression: "attribute_not_exists(sealedPackId)",
      ExpressionAttributeValues: { ":p": pack.packId, ":v": evaluation.verdict, ":s": "sealed", ":t": sealedAt },
    }),
  );
  log("pack_sealed", { loadId: load.loadId, packId: pack.packId, verdict: evaluation.verdict, confidence: corroboration.confidence, digest });
  return { packId: pack.packId, s3Key, digest, verdict: evaluation.verdict, confidence: corroboration.confidence, amountUsd: evaluation.amountUsd, reasons: evaluation.reasons };
}
