import { readFileSync } from "node:fs";
import { clauseById, evaluate } from "@dockclock/clause-engine";
import { buildPack, corroborate, facilityById, LocalSigner, sealPack, toLoadEvidence, type LoadRecord, type SignedPack } from "@dockclock/evidence";
import { describe, expect, it } from "vitest";
import { checkEngineInput, engineInputOf, inboundTitle, releaseTapOf, type Item } from "../api/describe.js";
import { buildLoadView } from "../api/view.js";
import { escalationEmail } from "../src/escalate.js";
import type { LoadItem } from "../src/store.js";

// The dock clock stops at the driver's Released tap; the release pin confirms it within 10 minutes.
// Packs sealed before this (version 1) have no tap: their release is the pin. The read API rebuilds
// engine inputs from either and must reproduce the sealed verdict and amount.
const facility = facilityById("lakeshore-columbus");
const INSIDE: [number, number] = [-82.938, 39.8995];
const T = (h: number, m: number) => `2026-10-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const clause = clauseById("lakeshore-foods");

// Arrived 09:50 EDT (13:50Z), appointment 10:00 EDT; the receiver-signed paper reads 09:52 and 13:19.
function record(tapAt: string | null, pinAt: string): LoadRecord {
  return {
    loadId: "LIVE-tap",
    clauseId: clause.id,
    facility,
    appointmentAt: T(14, 0),
    arrived: { kind: "arrived", channel: "whatsapp", messageId: "w-arr", serverAt: T(13, 50), location: INSIDE },
    ...(tapAt ? { releasedTap: { channel: "whatsapp" as const, messageId: "w-tap", serverAt: tapAt } } : {}),
    released: { kind: "released", channel: "whatsapp", messageId: "w-rel", serverAt: pinAt, location: INSIDE },
    bol: {
      channel: "whatsapp",
      messageId: "w-bol",
      serverAt: T(17, 40),
      cameraOnly: true,
      pageSha256s: ["ab".repeat(32)],
      timesEdited: { in: true, out: true },
      signed: true,
      checkIn: T(13, 52),
      checkOut: T(17, 19),
      confirmedByDriver: true,
    },
    status214: false,
    notice: { sentAt: T(15, 0), deliveredAt: T(15, 1), messageId: "ses-1" },
    shipperConfirmation: null,
  };
}

async function sealed(load: LoadRecord): Promise<SignedPack> {
  const evaluation = evaluate(toLoadEvidence(load, T(18, 0)), clause);
  return sealPack(buildPack(load, corroborate(load), evaluation, T(18, 0)), new LocalSigner());
}

// The load's META as the read API reads it: pins with coordinates, the form's typed times.
function meta(tapAt: string | null, pinAt: string): Item {
  return {
    pk: "LOAD#LIVE-tap",
    sk: "META",
    loadId: "LIVE-tap",
    ws: "demo",
    clauseId: clause.id,
    facilityId: facility.id,
    appointmentAt: T(14, 0),
    createdAt: T(13, 0),
    language: "en_US",
    channel: "whatsapp",
    phase: "sealed",
    arrived: { serverAt: T(13, 50), messageId: "w-arr", lat: INSIDE[1], lon: INSIDE[0] },
    ...(tapAt ? { releasedTap: { channel: "whatsapp", serverAt: tapAt, messageId: "w-tap" } } : {}),
    released: { serverAt: pinAt, messageId: "w-rel", lat: INSIDE[1], lon: INSIDE[0] },
    bol: { channel: "whatsapp", serverAt: T(17, 40), inTime: "09:52", outTime: "13:19", receiverSigned: true, photos: [] },
  };
}

// A version 1 pack as sealed before 2026-10-23: no tap, no clock end, a pin without its fence result.
function asVersion1(signed: SignedPack): SignedPack {
  const events: SignedPack["pack"]["events"] = { ...signed.pack.events };
  delete events.releasedTap;
  const pack: SignedPack["pack"] = { ...signed.pack, version: 1, events: { ...events, released: events.released && { serverAt: events.released.serverAt, messageId: events.released.messageId } } };
  delete pack.clockEnd;
  return { ...signed, pack };
}

describe("read API engine inputs, old and new packs", () => {
  it("rebuilds a new pack: release at the tap, the pin alongside, the sealed amount reproduced", async () => {
    const signed = await sealed(record(T(17, 20), T(17, 23)));
    expect(signed.pack.version).toBe(2);
    expect(releaseTapOf(signed)).toBe(T(17, 20));
    const input = engineInputOf(meta(T(17, 20), T(17, 23)), signed, facility.timeZone);
    expect(input.released).toEqual({ at: T(17, 20), insideGeofence: true });
    expect(input.releasePinAt).toBe(T(17, 23));
    expect(input.bol?.checkOut).toBe(T(17, 19));
    // 16:00Z free time ends; billed to the 17:20Z tap.
    expect(signed.pack.evaluation).toMatchObject({ verdict: "BILLABLE", detentionMinutes: 80 });
    expect(() => checkEngineInput(input, { loadId: "LIVE-tap", clause, facilityName: facility.name, evaluation: signed.pack.evaluation })).not.toThrow();
  });

  it("rebuilds a late-pin pack as needing a person", async () => {
    const signed = await sealed(record(T(17, 20), T(17, 32)));
    expect(signed.pack.evaluation).toMatchObject({ verdict: "NEEDS_HUMAN", reasons: ["RELEASE_PIN_LATE"] });
    const input = engineInputOf(meta(T(17, 20), T(17, 32)), signed, facility.timeZone);
    expect(() => checkEngineInput(input, { loadId: "LIVE-tap", clause, facilityName: facility.name, evaluation: signed.pack.evaluation })).not.toThrow();
  });

  it("still rebuilds a version 1 pack, whose release is the pin", async () => {
    const old = asVersion1(await sealed(record(null, T(17, 20))));
    expect(old.pack.version).toBe(1);
    expect(old.pack.events.releasedTap).toBeUndefined();
    expect(releaseTapOf(old)).toBeNull();
    const input = engineInputOf(meta(null, T(17, 20)), old, facility.timeZone);
    expect(input.released).toEqual({ at: T(17, 20), insideGeofence: true });
    expect(input.releasePinAt).toBeUndefined();
    expect(() => checkEngineInput(input, { loadId: "LIVE-tap", clause, facilityName: facility.name, evaluation: old.pack.evaluation })).not.toThrow();
  });

  it("reads the published version 1 pack as one without a tap", () => {
    const published = JSON.parse(readFileSync(new URL("../../docs/evidence/SMOKE-mve8yfv3.pack.json", import.meta.url), "utf8")) as SignedPack;
    expect(published.pack.version).toBe(1);
    expect(releaseTapOf(published)).toBeNull();
  });
});

describe("console views of the Released tap", () => {
  const view = async (tapAt: string | null, pinAt: string | null) => {
    const m = meta(tapAt, pinAt ?? T(0, 0));
    if (!pinAt) Object.assign(m, { released: null, phase: "awaiting_release_pin", bol: null });
    else Object.assign(m, { phase: "awaiting_bol", bol: null });
    return buildLoadView({ items: [m], receipts: {}, signedPack: null, emails: {}, photoTypes: {}, spkiSha256: "spki", now: T(17, 25) });
  };

  it("stops the clock band at the tap and says the pin is awaited", async () => {
    const v = await view(T(17, 20), null);
    expect(v.clock.releasedAt).toBe(T(17, 20));
    expect(v.summary.releasedAt).toBe(T(17, 20));
    const step = v.workflow.find((s) => s.key === "released")!;
    expect(step).toMatchObject({ label: "Driver tapped Released: the dock clock stopped", state: "current" });
    expect(step.detail).toBe("Clock stopped at 13:20 EDT. Waiting for the location pin that confirms it (within 10 minutes).");
    // Free time ended 12:00 EDT: 80 minutes, not counted on to 13:25 ("now").
    expect(v.clock.detentionMinutes).toBe(80);
  });

  it("says when the pin confirmed the tap, or that it came too late", async () => {
    const ok = (await view(T(17, 20), T(17, 23))).workflow.find((s) => s.key === "released")!;
    expect(ok).toMatchObject({ state: "done", at: T(17, 20), detail: "Clock stopped at 13:20 EDT. Confirmed by the location pin at 13:23 EDT, 3 min after the tap, inside the facility." });
    const late = (await view(T(17, 20), T(17, 32))).workflow.find((s) => s.key === "released")!;
    expect(late).toMatchObject({ state: "failed", detail: "Clock stopped at 13:20 EDT. The location pin came at 13:32 EDT, 12 min after the tap (limit 10), so a person reviews the load." });
    // A pin before the tap is not "later", and a gap just past the limit is not rounded onto it.
    const early = (await view(T(17, 20), T(17, 5))).workflow.find((s) => s.key === "released")!;
    expect(early).toMatchObject({ state: "failed", detail: "Clock stopped at 13:20 EDT. The location pin came at 13:05 EDT, 15 min before the tap (limit 10), so a person reviews the load." });
    const justOver = (await view(T(17, 20), new Date(Date.parse(T(17, 30)) + 25_000).toISOString())).workflow.find((s) => s.key === "released")!;
    expect(justOver.detail).toContain("10.5 min after the tap (limit 10)");
  });

  it("fails the release step on a pin time that does not parse, as the engine holds the load", async () => {
    const v = await view(T(17, 20), "not a time");
    const step = v.workflow.find((s) => s.key === "released")!;
    expect(step).toMatchObject({ state: "failed", detail: "Clock stopped at 13:20 EDT. The location pin's time could not be read. A person reviews the load." });
    expect(JSON.stringify(v.workflow)).not.toMatch(/NaN|Invalid/);
  });

  // A stored time that does not parse is shown as unreadable, never a 500 for the whole load.
  it("builds the view of a load whose arrival, tap or pin time does not parse", async () => {
    const items = (m: Item) => [m, { pk: m.pk, sk: "EVENT#garbage#w1", type: "location", serverAt: "garbage", detail: {} }];
    for (const phase of ["at_dock", "awaiting_bol", "closed"]) {
      const m = { ...meta("not a time", "not a time"), arrived: { serverAt: "garbage", messageId: "w-arr" }, phase, outcome: "TIMED_OUT_NEEDS_HUMAN" };
      const v = buildLoadView({ items: items(m), receipts: {}, signedPack: null, emails: {}, photoTypes: {}, spkiSha256: "spki", now: T(17, 25) });
      expect(v.clock, phase).toMatchObject({ arrivedAt: "garbage", freeTimeEndsAt: null, clockStartAt: null, detentionMinutes: 0 });
      expect(v.workflow.find((s) => s.key === "released"), phase).toMatchObject({ state: "failed" });
      expect(JSON.stringify(v), phase).not.toMatch(/NaN|Invalid/);
    }
    // A sealed load whose tap does not parse: the engine held it, and the paper's out time has no
    // date to be pinned to.
    const signed = await sealed(record("not a time", T(17, 23)));
    expect(signed.pack.evaluation).toMatchObject({ verdict: "NEEDS_HUMAN", reasons: ["TIMESTAMP_UNREADABLE"] });
    const m = meta("not a time", T(17, 23));
    const v = buildLoadView({ items: [m], receipts: {}, signedPack: signed, emails: {}, photoTypes: {}, spkiSha256: "spki", now: T(18, 30) });
    expect(v.verdict?.engineInput.bol?.checkOut).toBeNull();
    expect(v.verdict?.verdict).toBe("NEEDS_HUMAN");
  });

  it("keeps the old release step for a load without a tap", async () => {
    const v = await view(null, T(17, 20));
    expect(v.clock.releasedAt).toBe(T(17, 20));
    expect(v.workflow.find((s) => s.key === "released")).toMatchObject({ label: "Release confirmed by a location pin", state: "done", at: T(17, 20) });
  });

  it("names the tap on the timeline", () => {
    expect(inboundTitle("button", "ADVANCED", "released").title).toBe("Driver tapped Released: the dock clock stopped");
    expect(inboundTitle("button", "IGNORED_DUPLICATE_TAP", "released").title).toBe("Released tapped again: ignored");
  });
});

describe("dispatch emails name the Released tap as the release", () => {
  it("gives the tap's time, not the pin's", () => {
    const load = {
      loadId: "LIVE-tap",
      clauseId: clause.id,
      facilityId: facility.id,
      phase: "sealed",
      language: "en_US",
      channel: "whatsapp",
      address: { kind: "phone", e164: "+15550100001" },
      arrived: { serverAt: T(13, 50) },
      releasedTap: { serverAt: T(17, 20), messageId: "w-tap" },
      released: { serverAt: T(17, 32) },
    } as unknown as LoadItem;
    const { text } = escalationEmail(load, "sealed as NEEDS_HUMAN; review the pack before any claim", { pack: { confidence: "low", reasons: ["RELEASE_PIN_LATE"] } });
    expect(text).toContain("Released: 2026-10-13 13:20 EDT");
    expect(text).toContain("the release location was not shared within 10 minutes of tapping Released");
  });
});
