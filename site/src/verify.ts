import { packBytes } from "./canonical.js";

// Checks a sealed pack's KMS signature with the browser's own WebCrypto. No DockClock server is
// involved: the inputs are the pack, the base64 DER signature and the published public key (PEM).

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function pemToDer(pem: string): Uint8Array {
  return base64ToBytes(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, ""));
}

// KMS returns an ASN.1 DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }); WebCrypto wants
// r and s as two fixed 32-byte big-endian halves.
export function derToRaw(der: Uint8Array, size = 32): Uint8Array {
  let at = 0;
  const expect = (tag: number) => {
    if (der[at++] !== tag) throw new Error("not a DER ECDSA signature");
  };
  const length = () => {
    let len = der[at++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | der[at++]!;
    }
    return len;
  };
  expect(0x30);
  length();
  const out = new Uint8Array(size * 2);
  for (const half of [0, 1]) {
    expect(0x02);
    let len = length();
    let start = at;
    at += len;
    while (len > size && der[start] === 0) {
      start++;
      len--;
    }
    if (len > size) throw new Error("signature integer too long");
    out.set(der.subarray(start, start + len), half * size + (size - len));
  }
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VerifyResult {
  valid: boolean;
  digest: string;
}

export async function verifyPack(pack: unknown, signatureBase64: string, publicKeyPem: string): Promise<VerifyResult> {
  const key = await crypto.subtle.importKey("spki", pemToDer(publicKeyPem) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const bytes = packBytes(pack);
  const signature = derToRaw(base64ToBytes(signatureBase64));
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature as BufferSource, bytes as BufferSource);
  return { valid, digest: await sha256Hex(bytes) };
}
