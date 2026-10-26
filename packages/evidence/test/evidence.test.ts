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
  registerFacility,
  LocalSigner,
  messageRef,
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

describe("registerFacility", () => {
  it("adds a runtime facility without letting it replace a built-in one", () => {
    registerFacility({ id: "demo-test", name: "Demo", timeZone: "America/Toronto", polygon: [[0, 0], [0, 1], [1, 1]] });
    expect(facilityById("demo-test").timeZone).toBe("America/Toronto");
    expect(() => registerFacility({ ...facility, polygon: facility.polygon })).toThrow(/built in/);
  });
});

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

describe("photo reading", () => {
  it("counts receiver-written times that match the pins as independent", () => {
    const read = record();
    if (read.bol) {
      read.bol.timesEdited = { in: false, out: false };
      read.bol.photoReading = { legible: true, checkIn: "2026-10-13T13:52:00.000Z", checkOut: "2026-10-13T17:18:00.000Z", receiverSigned: true };
    }
    const result = corroborate(read);
    expect(result.confidence).toBe("high");
    expect(result.signals.find((s) => s.name === "bol_photo_in_matches_arrived_pin")).toMatchObject({ ok: true, independent: true });
  });

  it("is low when the photo is unreadable or contradicts the driver's signature tick", () => {
    const blurry = record();
    if (blurry.bol) blurry.bol.photoReading = { legible: false, checkIn: null, checkOut: null, receiverSigned: false };
    expect(corroborate(blurry).confidence).toBe("low");
    const contradicted = record();
    if (contradicted.bol) contradicted.bol.photoReading = { legible: true, checkIn: "2026-10-13T13:52:00.000Z", checkOut: "2026-10-13T17:18:00.000Z", receiverSigned: false };
    expect(corroborate(contradicted).signals.find((s) => s.name === "bol_photo_signature_matches")?.ok).toBe(false);
  });
});

describe("local date and time", () => {
  it("keeps the facility's own date after 20:00 Eastern, when the UTC date has already turned", async () => {
    const { isoToLocalDateTime } = await import("../src/index.js");
    expect(isoToLocalDateTime("2026-10-19T00:58:12.000Z", "America/New_York")).toBe("2026-10-18 20:58 EDT");
    expect(isoToLocalDateTime("2026-12-19T00:58:12.000Z", "America/Chicago")).toBe("2026-12-18 18:58 CST");
  });
});

describe("what a pack holds", () => {
  // The README and the demo intro promise the signed pack records times and photo hashes, not where
  // the driver was. This checks the pack the code builds, not a frozen file.
  it("carries no coordinates, even though the pins it is built from have them", () => {
    const load = record();
    expect(load.arrived?.location).toBeDefined();
    const evaluation = evaluate(toLoadEvidence(load, "2026-10-13T18:00:00.000Z"), clauseById("lakeshore-foods"));
    const pack = buildPack(load, corroborate(load), evaluation, "2026-10-13T18:00:00.000Z");
    const text = JSON.stringify(pack);
    expect(text).not.toMatch(/"(location|lat|lon|latitude|longitude)"/);
    expect(text).not.toMatch(/\[\s*-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,2}\.\d{3,}\s*\]/);
    const [lon, lat] = load.arrived!.location as unknown as [number, number];
    expect(text).not.toContain(String(lon));
    expect(text).not.toContain(String(lat));
  });
});

describe("message ids in a pack", () => {
  // A real wamid is base64 of a structure that starts with the sender's phone number. These are built
  // the same way from a 555 test number, so the test catches the leak a live pack would have.
  const wamid = (n: number) => `wamid.${Buffer.from(`\u0018\u000b15550100001\u0015\u0002\u0000\u0012\u0018\u0014${n}ABCDEF0123456789`).toString("base64")}`;

  // Every base64-looking run in the text, decoded, must not hold a 10+ digit number.
  const decodesToPhone = (text: string) =>
    (text.match(/[A-Za-z0-9+/=_-]{12,}/g) ?? []).some((run) => /\d{10,}/.test(Buffer.from(run.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1")));

  it("replaces every message id with a short sha256 reference", () => {
    const base = record();
    const load: LoadRecord = {
      ...base,
      arrived: { ...base.arrived!, messageId: wamid(1) },
      released: { ...base.released!, messageId: wamid(2) },
      bol: { ...base.bol!, messageId: wamid(3) },
      notice: { sentAt: "2026-10-13T15:00:00.000Z", deliveredAt: null, messageId: "0100019a-ses-id" },
    };
    expect(decodesToPhone(JSON.stringify(load))).toBe(true);
    const evaluation = evaluate(toLoadEvidence(load, "2026-10-13T18:00:00.000Z"), clauseById("lakeshore-foods"));
    const pack = buildPack(load, corroborate(load), evaluation, "2026-10-13T18:00:00.000Z");
    const text = JSON.stringify(pack);
    expect(text).not.toContain("wamid.");
    expect(decodesToPhone(text)).toBe(false);
    expect(pack.events.arrived?.messageId).toBe(messageRef(wamid(1)));
    expect(pack.events.arrived?.messageId).toMatch(/^msg-sha256:[0-9a-f]{16}$/);
    expect(pack.events.notice?.messageId).toMatch(/^msg-sha256:[0-9a-f]{16}$/);
    expect(messageRef(pack.events.bol!.messageId)).toBe(pack.events.bol!.messageId);
  });
});

describe("the Released tap ends the clock; the pin confirms it", () => {
  // lakeshore-foods: free time 2 h from the 14:00Z appointment (arrived early at 13:50Z).
  const tapped = (pinAt: string, overrides: Partial<LoadRecord> = {}): LoadRecord => {
    const base = record();
    return record({
      releasedTap: { channel: "whatsapp", messageId: "m-tap", serverAt: "2026-10-13T17:20:00.000Z" },
      released: { ...base.released!, serverAt: pinAt },
      bol: { ...base.bol!, checkOut: "2026-10-13T17:22:00.000Z" },
      ...overrides,
    });
  };

  it("bills to the tap when the pin comes 3 minutes later", () => {
    const evidence = toLoadEvidence(tapped("2026-10-13T17:23:00.000Z"), "2026-10-13T18:00:00.000Z");
    expect(evidence.released).toEqual({ at: "2026-10-13T17:20:00.000Z", insideGeofence: true });
    expect(evidence.releasePinAt).toBe("2026-10-13T17:23:00.000Z");
    const result = evaluate(evidence, clauseById("lakeshore-foods"));
    expect(result.verdict).toBe("BILLABLE");
    // 16:00Z free time ends, 17:20Z tap: 80 minutes, not the 83 to the pin.
    expect(result.detentionMinutes).toBe(80);
  });

  it("sends a pin 12 minutes after the tap to a person", () => {
    const load = tapped("2026-10-13T17:32:00.000Z");
    const result = evaluate(toLoadEvidence(load, "2026-10-13T18:00:00.000Z"), clauseById("lakeshore-foods"));
    expect(result).toMatchObject({ verdict: "NEEDS_HUMAN", reasons: ["RELEASE_PIN_LATE"] });
    const signal = corroborate(load).signals.find((s) => s.name === "released_pin_confirms_tap");
    expect(signal).toMatchObject({ ok: false, detail: expect.stringContaining("12 min after the Released tap (limit 10)") });
    expect(corroborate(load).confidence).toBe("low");
  });

  it("records a pin time that does not parse as unconfirmed, with no NaN, and the engine holds the load", () => {
    const load = tapped("not a time", { bol: { ...record().bol!, checkOut: "not a time either" } });
    const result = evaluate(toLoadEvidence(load, "2026-10-13T18:00:00.000Z"), clauseById("lakeshore-foods"));
    expect(result).toMatchObject({ verdict: "NEEDS_HUMAN", reasons: ["TIMESTAMP_UNREADABLE"] });
    const corroboration = corroborate(load);
    expect(corroboration.signals.find((s) => s.name === "released_pin_confirms_tap")).toMatchObject({ ok: false, detail: expect.stringContaining("could not be read") });
    expect(corroboration.signals.find((s) => s.name === "bol_out_matches_released_tap")).toMatchObject({ ok: false, detail: expect.stringMatching(/^a time could not be read/) });
    expect(corroboration.confidence).toBe("low");
    expect(JSON.stringify(corroboration)).not.toMatch(/NaN/);
  });

  it("compares the paper's out time with the tap", () => {
    // Paper 17:22Z: 2 minutes after the tap, 7 before the pin. Both inside 15; the signal names the tap.
    const signals = corroborate(tapped("2026-10-13T17:29:00.000Z")).signals;
    expect(signals.find((s) => s.name === "bol_out_matches_released_tap")).toMatchObject({ ok: true, detail: expect.stringMatching(/^2 min apart/) });
    expect(signals.some((s) => s.name === "bol_out_matches_released_pin")).toBe(false);
    // A paper time 16 minutes after the tap conflicts, even though it is 7 minutes from the pin.
    const late = tapped("2026-10-13T17:29:00.000Z", { bol: { ...record().bol!, checkOut: "2026-10-13T17:36:00.000Z" } });
    expect(evaluate(toLoadEvidence(late, "2026-10-13T18:00:00.000Z"), clauseById("lakeshore-foods")).reasons).toEqual(["BOL_TIMESTAMP_CONFLICT"]);
  });

  it("records both times in a version 2 pack, which verifies", async () => {
    const load = tapped("2026-10-13T17:23:00.000Z");
    const evaluation = evaluate(toLoadEvidence(load, "2026-10-13T18:00:00.000Z"), clauseById("lakeshore-foods"));
    const pack = buildPack(load, corroborate(load), evaluation, "2026-10-13T18:00:00.000Z");
    expect(pack.version).toBe(2);
    expect(pack.events.releasedTap).toEqual({ serverAt: "2026-10-13T17:20:00.000Z", channel: "whatsapp", messageId: messageRef("m-tap") });
    expect(pack.events.released).toEqual({ serverAt: "2026-10-13T17:23:00.000Z", messageId: messageRef("m-rel"), insideGeofence: true });
    expect(pack.clockEnd).toEqual({ by: "released_tap", at: "2026-10-13T17:20:00.000Z" });
    const signer = new LocalSigner();
    expect(verifyPack(await sealPack(pack, signer), await signer.publicKeyDer())).toBe(true);
  });

  it("keeps release-is-the-pin for a record without a tap", () => {
    const load = record();
    const evidence = toLoadEvidence(load, "2026-10-13T18:00:00.000Z");
    expect(evidence.releasePinAt).toBeUndefined();
    expect(evidence.released?.at).toBe(load.released!.serverAt);
    const pack = buildPack(load, corroborate(load), evaluate(evidence, clauseById("lakeshore-foods")), "2026-10-13T18:00:00.000Z");
    expect(pack.events.releasedTap).toBeNull();
    expect(pack.clockEnd).toEqual({ by: "released_pin", at: load.released!.serverAt });
    expect(corroborate(load).signals.some((s) => s.name === "bol_out_matches_released_pin")).toBe(true);
  });
});
