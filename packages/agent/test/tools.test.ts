import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { GetPublicKeyCommand, KMSClient } from "@aws-sdk/client-kms";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseMime } from "@dockclock/sanitize";
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

  it("attaches the PDF and the same pack file it read, once; the public key is linked, not attached", async () => {
    kms.on(GetPublicKeyCommand).resolves({ PublicKey: der });
    await handler(claim, context);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(1);
    const raw = Buffer.from(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Content!.Raw!.Data!).toString();
    const parsed = parseMime(raw);
    expect(parsed.attachments.map((a) => a.name)).toEqual(["detention-claim-SMOKE-mve8yfv3.pdf", `${manifest.pack.packId}.json`]);
    expect(parsed.attachments[1]!.sha256).toBe(createHash("sha256").update(packJson).digest("hex"));
    // The subject comes from the template, not from the agent.
    expect(parsed.subject).toBe("Detention claim: Load SMOKE-mve8yfv3 at Lakeshore DC, Columbus OH, $90.99");
    // The agent's opening, then the sealed facts; the key's ARN appears nowhere in the body.
    expect(parsed.text).toContain(claim.body);
    expect(parsed.text).toContain("Amount due: $90.99");
    expect(parsed.text).toContain(`Evidence pack ${manifest.pack.packId}, sha256 ${manifest.pack.packDigestSha256.slice(0, 16)}`);
    expect(parsed.text).toContain("Public key: https://d3djuoqhg6b8o2.cloudfront.net/keys/public-key.pem");
    expect(parsed.text).not.toContain("arn:aws");
    expect(parsed.text).not.toContain("111122223333");
    expect(raw).not.toContain("dockclock-public-key.pem");
  });

  it("keeps the PDF it attached next to the load's packs and points the claim record at it", async () => {
    kms.on(GetPublicKeyCommand).resolves({ PublicKey: der });
    await handler(claim, context);
    const raw = Buffer.from(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Content!.Raw!.Data!).toString();
    const pdfPut = s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input).find((i) => i.Key === "packs/SMOKE-mve8yfv3/claim.pdf")!;
    expect(pdfPut).toMatchObject({ Bucket: "evidence", ContentType: "application/pdf" });
    const attached = parseMime(raw).attachments[0]!;
    expect(createHash("sha256").update(pdfPut.Body as Uint8Array).digest("hex")).toBe(attached.sha256);
    const update = dynamo.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.ExpressionAttributeValues).toMatchObject({ ":p": "packs/SMOKE-mve8yfv3/claim.pdf", ":pn": "detention-claim-SMOKE-mve8yfv3.pdf", ":sub": parseMime(raw).subject });
  });

  it("refuses a different amount or digest before anything is built or reserved", async () => {
    kms.on(GetPublicKeyCommand).resolves({ PublicKey: der });
    expect(await handler({ ...claim, amountCents: 9100 }, context)).toMatchObject({ refused: expect.stringContaining("differs from the contract amount 9099 cents") });
    expect(await handler({ ...claim, packDigest: "0".repeat(64) }, context)).toMatchObject({ refused: expect.stringContaining("digest does not match") });
    expect(dynamo.commandCalls(PutCommand)).toHaveLength(0);
    expect(ses.calls()).toHaveLength(0);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it("keeps the exact claim email next to the load's packs and points the claim record at it", async () => {
    kms.on(GetPublicKeyCommand).resolves({ PublicKey: der });
    await handler(claim, context);
    // Tagged with its load, so SES delivery events can be recorded on the claim.
    expect(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.EmailTags).toContainEqual({ Name: "loadId", Value: "SMOKE-mve8yfv3" });
    const raw = Buffer.from(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Content!.Raw!.Data!).toString();
    const put = s3.commandCalls(PutObjectCommand).map((c) => c.args[0].input).find((i) => i.Key === "packs/SMOKE-mve8yfv3/claim.eml")!;
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
    expect(update.UpdateExpression).not.toContain("pdfKey");
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
