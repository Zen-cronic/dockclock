import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handler, publicKeyOf } from "../src/tools.js";

// The published pack is a real sealed pack, so the claim tool can be run end to end against it.
const docs = new URL("../../../docs/evidence/", import.meta.url);
const packJson = readFileSync(new URL("SMOKE-mve8yfv3.pack.json", docs), "utf8");
const publishedPem = readFileSync(new URL("public-key.pem", docs), "utf8");
const der = createPublicKey(publishedPem).export({ format: "der", type: "spki" });
const manifest = JSON.parse(readFileSync(new URL("MANIFEST.json", docs), "utf8")) as { pack: { packId: string; packDigestSha256: string } };

const dynamo = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const ses = mockClient(SESv2Client);
const kms = mockClient(KMSClient);
const context = { clientContext: { custom: { bedrockAgentCoreToolName: "dockclock-tools___send_detention_claim" } } } as unknown as Context;
const claim = {
  loadId: "SMOKE-mve8yfv3",
  subject: "Detention claim for load SMOKE-mve8yfv3",
  body: "Load SMOKE-mve8yfv3 waited past free time at Lakeshore DC. Under the contract the detention owed is $90.99. The signed evidence pack is attached.",
  amountCents: 9099,
  packDigest: manifest.pack.packDigestSha256,
  approvalId: "appr-1",
};

describe("send_detention_claim", () => {
  beforeAll(() => {
    Object.assign(process.env, {
      TABLE_NAME: "loads",
      EVIDENCE_BUCKET: "evidence",
      CLAIMS_FROM_EMAIL: "claims@example.com",
      REPLY_TO_EMAIL: "dispatch@example.com",
      SES_CONFIGURATION_SET: "dockclock-claims",
      COUNTERPARTY_EMAIL_SHIPPER: "shipper@example.com",
      COUNTERPARTY_EMAIL_BROKER: "broker@example.com",
    });
  });

  beforeEach(() => {
    for (const m of [dynamo, s3, ses, kms]) m.reset();
    const items: Record<string, unknown> = {
      META: { loadId: "SMOKE-mve8yfv3", phase: "sealed", clauseId: "lakeshore-foods", facilityId: "lakeshore-columbus", sealedPackId: manifest.pack.packId },
      [`PACK#${manifest.pack.packId}`]: { s3Key: "packs/x.json", digest: manifest.pack.packDigestSha256, keyId: "arn:aws:kms:us-east-1:111122223333:key/test-claim", verdict: "BILLABLE", confidence: "low" },
      APPROVAL: { approvalId: "appr-1" },
    };
    dynamo.on(GetCommand).callsFake(async (input: { Key: { sk: string } }) => ({ Item: items[input.Key.sk] }));
    dynamo.on(PutCommand).resolves({});
    s3.on(GetObjectCommand).resolves({ Body: { transformToString: async () => packJson } } as never);
    ses.on(SendEmailCommand).resolves({ MessageId: "ses-1" });
    s3.on(PutObjectCommand).resolves({});
    dynamo.on(UpdateCommand).resolves({});
  });

  it("reserves nothing when the public key cannot be fetched, so a retry can still file", async () => {
    kms.on(GetPublicKeyCommand).rejectsOnce(Object.assign(new Error("slow down"), { name: "ThrottlingException" })).resolves({ PublicKey: der });
    await expect(handler(claim, context)).rejects.toThrow("slow down");
    expect(dynamo.commandCalls(PutCommand)).toHaveLength(0);
    expect(ses.calls()).toHaveLength(0);
    // The failed fetch is not cached: the retry fetches again and files.
    expect(await handler(claim, context)).toMatchObject({ sent: true, sesMessageId: "ses-1" });
    expect(dynamo.commandCalls(PutCommand)).toHaveLength(1);
  });

  it("attaches the same pack file it read, once, and the published public key byte for byte", async () => {
    kms.on(GetPublicKeyCommand).resolves({ PublicKey: der });
    await handler(claim, context);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(1);
    const raw = Buffer.from(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Content!.Raw!.Data!).toString();
    const parts = raw.split(/--dockclock-[a-z0-9]+/);
    const decoded = parts.map((p) => p.split("\r\n\r\n")[1]).filter(Boolean).map((b) => Buffer.from(b!.replace(/\r\n/g, ""), "base64").toString());
    expect(decoded).toContain(packJson);
    expect(decoded).toContain(publishedPem);
    expect(decoded[0]).toContain('over the SHA-256 of the file\'s "pack" field written as canonical JSON');
    // The footer names each attachment with its hash, before the verification rule.
    expect(decoded[0]).toContain(`Attached:\n- ${manifest.pack.packId}.json: the signed evidence pack (sha256 ${manifest.pack.packDigestSha256})\n- dockclock-public-key.pem: the public key (SPKI sha256 `);
    expect(decoded[0]!.indexOf("Attached:")).toBeLessThan(decoded[0]!.indexOf("To verify:"));
  });

  it("keeps the exact claim email next to the load's packs and points the claim record at it", async () => {
    kms.on(GetPublicKeyCommand).resolves({ PublicKey: der });
    await handler(claim, context);
    // Tagged with its load, so SES delivery events can be recorded on the claim.
    expect(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.EmailTags).toContainEqual({ Name: "loadId", Value: "SMOKE-mve8yfv3" });
    const raw = Buffer.from(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Content!.Raw!.Data!).toString();
    const put = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put).toMatchObject({ Bucket: "evidence", Key: "packs/SMOKE-mve8yfv3/claim.eml", ContentType: "message/rfc822" });
    expect(put.Body).toBe(raw);
    const update = dynamo.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.UpdateExpression).toContain("mimeKey = :k");
    expect(update.ExpressionAttributeValues?.[":k"]).toBe("packs/SMOKE-mve8yfv3/claim.eml");
  });

  it("still records the sent claim when keeping the copy fails", async () => {
    kms.on(GetPublicKeyCommand).resolves({ PublicKey: der });
    s3.on(PutObjectCommand).rejects(new Error("denied"));
    expect(await handler(claim, context)).toMatchObject({ sent: true });
    const update = dynamo.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.UpdateExpression).not.toContain("mimeKey");
    expect(update.ExpressionAttributeValues?.[":s"]).toBe("sent");
  });
});

describe("public key cache", () => {
  it("forgets a failed fetch", async () => {
    let calls = 0;
    const fetchDer = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return der;
    };
    await expect(publicKeyOf("arn:test-cache", fetchDer)).rejects.toThrow("transient");
    await expect(publicKeyOf("arn:test-cache", fetchDer)).resolves.toMatchObject({ pem: publishedPem });
    expect(calls).toBe(2);
  });
});
