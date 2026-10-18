import { createHash, createPublicKey } from "node:crypto";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { mockClient } from "aws-sdk-client-mock";
import { clauseById, evaluate } from "@dockclock/clause-engine";
import { describe, expect, it } from "vitest";
import {
  buildPack,
  canonicalJson,
  checkGeofence,
  corroborate,
  facilityById,
  KmsSigner,
  LocalSigner,
  packBytes,
  packDigest,
  sealPack,
  toLoadEvidence,
  verifyPack,
  type LoadRecord,
} from "../src/index.js";

const facility = facilityById("lakeshore-columbus");
const INSIDE: [number, number] = [-82.938, 39.8995];
const OUTSIDE: [number, number] = [-82.95, 39.8995];

function record(overrides: Partial<LoadRecord> = {}): LoadRecord {
  return {
    loadId: "4471",
    clauseId: "lakeshore-foods",
    facility,
    appointmentAt: "2026-10-13T14:00:00.000Z",
    arrived: { kind: "arrived", channel: "whatsapp", messageId: "m-arr", serverAt: "2026-10-13T13:50:00.000Z", location: INSIDE },
    released: { kind: "released", channel: "whatsapp", messageId: "m-rel", serverAt: "2026-10-13T17:20:00.000Z", location: INSIDE },
    bol: {
      channel: "whatsapp",
      messageId: "m-bol",
      serverAt: "2026-10-13T17:21:00.000Z",
      cameraOnly: true,
      pageSha256s: ["ab".repeat(32)],
      timesEdited: { in: true, out: true },
      signed: true,
      checkIn: "2026-10-13T13:52:00.000Z",
      checkOut: "2026-10-13T17:18:00.000Z",
      confirmedByDriver: true,
    },
    status214: false,
    notice: null,
    shipperConfirmation: null,
    ...overrides,
  };
}

describe("geofence", () => {
  it("accepts a pin inside the yard and measures one outside it", () => {
    expect(checkGeofence(INSIDE, facility).inside).toBe(true);
    const out = checkGeofence(OUTSIDE, facility);
    expect(out.inside).toBe(false);
    expect(out.distanceMeters).toBeGreaterThan(700);
    expect(out.distanceMeters).toBeLessThan(900);
  });
});

describe("toLoadEvidence", () => {
  it("feeds the clause engine a billable claim from clean events", () => {
    const evidence = toLoadEvidence(record(), "2026-10-13T18:00:00.000Z");
    const result = evaluate(evidence, clauseById("lakeshore-foods"));
    expect(result.verdict).toBe("BILLABLE");
    expect(result.amountUsd).toBe(80);
  });

  it("routes a pin outside the facility to a person", () => {
    const moved = record({
      released: { kind: "released", channel: "rcs", messageId: "m-rel", serverAt: "2026-10-13T17:20:00.000Z", location: OUTSIDE },
    });
    const result = evaluate(toLoadEvidence(moved, "2026-10-13T18:00:00.000Z"), clauseById("lakeshore-foods"));
    expect(result.verdict).toBe("NEEDS_HUMAN");
    expect(result.reasons).toEqual(["PIN_OUTSIDE_GEOFENCE"]);
  });
});

describe("corroborate", () => {
  it("is high when the BOL agrees with both pins", () => {
    expect(corroborate(record()).confidence).toBe("high");
  });

  it("is medium with pins alone, because a shared pin can be moved", () => {
    expect(corroborate(record({ bol: null })).confidence).toBe("medium");
  });

  it("is medium, not high, when the BOL times are the pre-filled pin times left unchanged", () => {
    const echoed = record();
    if (echoed.bol) echoed.bol.timesEdited = { in: false, out: false };
    const result = corroborate(echoed);
    expect(result.confidence).toBe("medium");
    expect(result.signals.find((s) => s.name === "bol_in_matches_arrived_pin")?.detail).toContain("not independent");
  });

  it("attests every page and fails when any page is missing", () => {
    const partial = record();
    if (partial.bol) partial.bol.pageSha256s = ["ab".repeat(32), null, "cd".repeat(32)];
    const signal = corroborate(partial).signals.find((s) => s.name === "bol_media_hashed");
    expect(signal).toMatchObject({ ok: false, detail: "2 of 3 pages stored and hashed" });
  });

  it("is low when any signal disagrees", () => {
    const gallery = record();
    if (gallery.bol) gallery.bol.cameraOnly = false;
    expect(corroborate(gallery).confidence).toBe("low");
  });
});

describe("evidence pack", () => {
  const evidence = toLoadEvidence(record(), "2026-10-13T18:00:00.000Z");
  const pack = buildPack(record(), corroborate(record()), evaluate(evidence, clauseById("lakeshore-foods")), "2026-10-13T18:00:00.000Z");

  it("serializes canonically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(packDigest(pack)).toBe(packDigest(JSON.parse(JSON.stringify(pack))));
  });

  it("verifies with the public key and fails after tampering", async () => {
    const signer = new LocalSigner();
    const signed = await sealPack(pack, signer);
    const pub = await signer.publicKeyDer();
    expect(verifyPack(signed, pub)).toBe(true);
    const tampered = { ...signed, pack: { ...signed.pack, evaluation: { ...signed.pack.evaluation, amountUsd: 999 } } };
    expect(verifyPack(tampered, pub)).toBe(false);
  });

  it("signs a digest through KMS with ECDSA_SHA_256", async () => {
    const local = new LocalSigner();
    const kms = mockClient(KMSClient);
    const bytes = packBytes(pack);
    kms.on(SignCommand).callsFake(async (input: { Message: Uint8Array; MessageType: string; SigningAlgorithm: string }) => {
      expect(input.MessageType).toBe("DIGEST");
      expect(input.SigningAlgorithm).toBe("ECDSA_SHA_256");
      expect(Buffer.from(input.Message)).toEqual(createHash("sha256").update(bytes).digest());
      return { Signature: await local.signBytes(bytes) };
    });
    kms.on(GetPublicKeyCommand).resolves({ PublicKey: await local.publicKeyDer() });
    const signer = new KmsSigner("alias/dockclock-evidence", new KMSClient({ region: "us-east-1" }));
    const signed = await sealPack(pack, signer);
    const pub = await signer.publicKeyDer();
    expect(createPublicKey({ key: pub, format: "der", type: "spki" }).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(verifyPack(signed, pub)).toBe(true);
    kms.restore();
  });
});
