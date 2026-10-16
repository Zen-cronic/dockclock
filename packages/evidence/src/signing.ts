import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { packBytes, type EvidencePack } from "./pack.js";

export interface SignedPack {
  pack: EvidencePack;
  keyId: string;
  algorithm: "ECDSA_SHA_256";
  signatureBase64: string;
}

export interface Signer {
  keyId: string;
  signBytes(bytes: Buffer): Promise<Buffer>;
  publicKeyDer(): Promise<Buffer>;
}

// ECDSA P-256 over SHA-256 of the canonical pack bytes. Anyone holding the public key can check a
// pack without AWS access.
export async function sealPack(pack: EvidencePack, signer: Signer): Promise<SignedPack> {
  const signature = await signer.signBytes(packBytes(pack));
  return { pack, keyId: signer.keyId, algorithm: "ECDSA_SHA_256", signatureBase64: signature.toString("base64") };
}

export function verifyPack(signed: SignedPack, publicKeyDer: Buffer): boolean {
  const key = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  return verify("sha256", packBytes(signed.pack), key, Buffer.from(signed.signatureBase64, "base64"));
}

export class LocalSigner implements Signer {
  readonly keyId: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(keyId = "local-test-key") {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.keyId = keyId;
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  async signBytes(bytes: Buffer): Promise<Buffer> {
    return sign("sha256", bytes, { key: this.privateKey, dsaEncoding: "der" });
  }

  async publicKeyDer(): Promise<Buffer> {
    return this.publicKey.export({ format: "der", type: "spki" });
  }
}

export class KmsSigner implements Signer {
  constructor(
    readonly keyId: string,
    private readonly client: KMSClient = new KMSClient({}),
  ) {}

  // KMS signs the SHA-256 digest (DIGEST mode), so packs larger than 4 KB can be signed.
  async signBytes(bytes: Buffer): Promise<Buffer> {
    const digest = createHash("sha256").update(bytes).digest();
    const out = await this.client.send(
      new SignCommand({ KeyId: this.keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
    );
    if (!out.Signature) throw new Error("KMS returned no signature");
    return Buffer.from(out.Signature);
  }

  async publicKeyDer(): Promise<Buffer> {
    const out = await this.client.send(new GetPublicKeyCommand({ KeyId: this.keyId }));
    if (!out.PublicKey) throw new Error("KMS returned no public key");
    return Buffer.from(out.PublicKey);
  }
}
