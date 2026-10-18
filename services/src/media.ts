import { createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetWhatsAppMessageMediaCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { BolPhoto, BolRecord } from "./lifecycle.js";
import { ddb, getLoad } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const s3 = new S3Client({});
const messaging = new SocialMessagingClient({});
// Errors that mean the media will never download: expired, unknown or not ours.
const GONE = new Set(["ResourceNotFoundException", "ValidationException", "InvalidParametersException", "AccessDeniedByMetaException"]);

async function storeAndHash(loadId: string, photo: BolPhoto): Promise<BolPhoto | null> {
  const prefix = `media/${loadId}/`;
  try {
    await messaging.send(
      new GetWhatsAppMessageMediaCommand({
        mediaId: photo.mediaId,
        originationPhoneNumberId: env.originationPhoneId(),
        destinationS3File: { bucketName: env.mediaBucket(), key: prefix },
      }),
    );
  } catch (error) {
    if (GONE.has((error as Error).name)) {
      log("media_unavailable", { loadId, mediaId: photo.mediaId, error: (error as Error).name });
      return null;
    }
    throw error;
  }
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: env.mediaBucket(), Prefix: `${prefix}${photo.mediaId}` }));
  const s3Key = listed.Contents?.[0]?.Key;
  if (!s3Key) throw new Error(`media ${photo.mediaId} downloaded but not found under ${prefix}`);
  const object = await s3.send(new GetObjectCommand({ Bucket: env.mediaBucket(), Key: s3Key }));
  const bytes = await object.Body!.transformToByteArray();
  return { ...photo, s3Key, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const RCS_MEDIA_PREFIX = "rcs-inbound/rcs/";
const RCS_MEDIA_MAX_AGE_MS = 15 * 60_000;

// RCS photos are already in our bucket (End User Messaging stored them); they are hashed from that
// copy. A photo the service could not store has no key and is unavailable. Because an RCS media
// notice arrives as JSON in the same field as typed text, a key is accepted only if it is under the
// inbound prefix, was written just before the message, and has not been claimed by another message.
async function hashStored(loadId: string, photo: BolPhoto, messageAt: string): Promise<BolPhoto | null> {
  const unavailable = (error: string) => {
    log("media_unavailable", { loadId, mediaId: photo.mediaId, error });
    return null;
  };
  if (!photo.s3Key) return unavailable("RCS media was not stored");
  if (!photo.s3Key.startsWith(RCS_MEDIA_PREFIX)) return unavailable("RCS media key outside the inbound prefix");
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: env.mediaBucket(), Key: photo.s3Key }));
    const writtenAt = head.LastModified?.getTime() ?? 0;
    if (Date.parse(messageAt) - writtenAt > RCS_MEDIA_MAX_AGE_MS || writtenAt - Date.parse(messageAt) > 60_000) {
      return unavailable("RCS media was not written with this message");
    }
    try {
      await ddb.send(
        new PutCommand({
          TableName: env.table(),
          Item: { pk: `MEDIAKEY#${photo.s3Key}`, sk: "CLAIM", loadId, mediaId: photo.mediaId, claimedAt: new Date().toISOString() },
          ConditionExpression: "attribute_not_exists(pk) OR (loadId = :l AND mediaId = :m)",
          ExpressionAttributeValues: { ":l": loadId, ":m": photo.mediaId },
        }),
      );
    } catch (error) {
      if ((error as Error).name === "ConditionalCheckFailedException") return unavailable("RCS media key already claimed by another message");
      throw error;
    }
    const object = await s3.send(new GetObjectCommand({ Bucket: env.mediaBucket(), Key: photo.s3Key }));
    const bytes = await object.Body!.transformToByteArray();
    return { ...photo, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    const name = (error as Error).name;
    if (name === "NoSuchKey" || name === "NotFound") return unavailable("NoSuchKey");
    throw error;
  }
}

// Finishes the bill-of-lading capture: every photo stored in S3 and hashed from our own copy.
// Idempotent, so both the first delivery and any redelivery of the Flow reply can call it.
export async function finishBol(loadId: string): Promise<BolRecord | null> {
  const load = await getLoad(loadId);
  const bol = load?.bol;
  if (!bol || bol.media !== "pending") return bol ?? null;
  const photos: BolPhoto[] = [];
  let missing = 0;
  for (const photo of bol.photos) {
    if (photo.sha256) {
      photos.push(photo);
      continue;
    }
    const stored = bol.channel === "rcs" ? await hashStored(loadId, photo, bol.serverAt) : await storeAndHash(loadId, photo);
    if (stored) photos.push(stored);
    else {
      photos.push(photo);
      missing++;
    }
  }
  const media: BolRecord["media"] = missing === 0 ? "hashed" : "unavailable";
  await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.load(loadId),
      UpdateExpression: "SET bol.photos = :p, bol.media = :m",
      ConditionExpression: "bol.media = :pending",
      ExpressionAttributeValues: { ":p": photos, ":m": media, ":pending": "pending" },
    }),
  ).catch((error: Error) => {
    if (error.name !== "ConditionalCheckFailedException") throw error;
  });
  log("bol_media_finished", { loadId, photos: photos.length, missing, media });
  return { ...bol, photos, media };
}
