import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { clauseById, evaluate } from "@dockclock/clause-engine";
import {
  buildPack,
  corroborate,
  facilityById,
  KmsSigner,
  packDigest,
  sealPack,
  toLoadEvidence,
  type LoadRecord,
  type PinEvent,
} from "@dockclock/evidence";
import type { PinRecord } from "./lifecycle.js";
import { ddb, getLoad, type LoadItem } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const s3 = new S3Client({});
const RETENTION_DAYS = 30;

function pinEvent(kind: PinEvent["kind"], pin: PinRecord | null, load: LoadItem): PinEvent | null {
  return pin && { kind, channel: load.channel, messageId: pin.messageId, serverAt: pin.serverAt, location: [pin.lon, pin.lat] };
}

export function toRecord(load: LoadItem): LoadRecord {
  return {
    loadId: load.loadId,
    clauseId: load.clauseId,
    facility: facilityById(load.facilityId),
    appointmentAt: load.appointmentAt,
    arrived: pinEvent("arrived", load.arrived, load),
    released: pinEvent("released", load.released, load),
    bol: null,
    status214: false,
    notice: null,
    shipperConfirmation: null,
  };
}

export interface SealOutput {
  packId: string;
  s3Key: string;
  digest: string;
  verdict: string;
  confidence: string;
}

// Evaluates the load against its clause, signs the pack with the KMS key, and writes it to the
// Object Lock bucket so it cannot be changed or deleted during the retention window.
export async function handler(input: { loadId: string }): Promise<SealOutput> {
  const load = await getLoad(input.loadId);
  if (!load) throw new Error(`load ${input.loadId} missing`);
  const sealedAt = new Date().toISOString();
  const record = toRecord(load);
  const evaluation = evaluate(toLoadEvidence(record, sealedAt), clauseById(load.clauseId));
  const corroboration = corroborate(record);
  const pack = buildPack(record, corroboration, evaluation, sealedAt);
  const signed = await sealPack(pack, new KmsSigner(env.keyId()));
  const s3Key = `packs/${load.loadId}/${pack.packId}.json`;
  await s3.send(
    new PutObjectCommand({
      Bucket: env.bucket(),
      Key: s3Key,
      Body: JSON.stringify(signed),
      ContentType: "application/json",
      ChecksumAlgorithm: "SHA256",
      ObjectLockMode: "GOVERNANCE",
      ObjectLockRetainUntilDate: new Date(Date.now() + RETENTION_DAYS * 86_400_000),
    }),
  );
  const digest = packDigest(pack);
  await ddb.send(
    new PutCommand({
      TableName: env.table(),
      Item: { ...keys.pack(load.loadId, pack.packId), s3Key, digest, keyId: signed.keyId, verdict: evaluation.verdict, confidence: corroboration.confidence, sealedAt },
    }),
  );
  await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.load(load.loadId),
      UpdateExpression: "SET sealedPackId = :p, verdict = :v",
      ExpressionAttributeValues: { ":p": pack.packId, ":v": evaluation.verdict },
    }),
  );
  log("pack_sealed", { loadId: load.loadId, packId: pack.packId, verdict: evaluation.verdict, confidence: corroboration.confidence, digest });
  return { packId: pack.packId, s3Key, digest, verdict: evaluation.verdict, confidence: corroboration.confidence };
}
