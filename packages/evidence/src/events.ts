import type { BolReading, LoadEvidence } from "@dockclock/clause-engine";
import { BOL_TOLERANCE_MINUTES, clockEndOf, releasePinCheck, releasePinGapWords, RELEASE_PIN_WINDOW_MINUTES, type ClockEnd } from "@dockclock/clause-engine";
import { checkGeofence, type Facility, type LonLat } from "./geofence.js";

export type Channel = "whatsapp" | "rcs";

// A driver interaction as received from AWS End User Messaging. `serverAt` is the platform's
// timestamp for the inbound message, never a time the driver typed.
export interface PinEvent {
  kind: "arrived" | "released";
  channel: Channel;
  messageId: string;
  serverAt: string;
  location: LonLat;
}

// The driver's Released button tap (WhatsApp button or RCS suggested reply). Its server time is
// when the dock clock stops; the release location pin that follows only confirms it.
export interface TapEvent {
  channel: Channel;
  messageId: string;
  serverAt: string;
}

export interface BolCapture {
  channel: Channel;
  messageId: string;
  serverAt: string;
  cameraOnly: boolean;
  // One entry per page: SHA-256 of the bytes we stored, or null when that page could not be retrieved.
  pageSha256s: Array<string | null>;
  // Whether the driver changed each time from the value pre-filled from their pin. An unchanged
  // value is the pin echoed back, so it cannot corroborate the pin.
  timesEdited: { in: boolean; out: boolean };
  // What a vision model read from the photo, times already pinned to instants. The comparison with
  // the pins is done here, in code; the model only reports what is written.
  photoReading?: { legible: boolean; checkIn: string | null; checkOut: string | null; receiverSigned: boolean };
  // Times read from the photo by the model, then confirmed or corrected by the driver.
  signed: boolean;
  checkIn: string | null;
  checkOut: string | null;
  confirmedByDriver: boolean;
}

export interface NoticeReceipt {
  sentAt: string;
  deliveredAt: string | null;
  messageId: string;
}

export interface CounterpartyConfirmation {
  at: string;
  channel: Channel | "email";
  confirmed: boolean;
}

export interface LoadRecord {
  loadId: string;
  clauseId: string;
  facility: Facility;
  appointmentAt: string;
  arrived: PinEvent | null;
  // Absent or null on loads recorded before the tap was kept: their release is the pin.
  releasedTap?: TapEvent | null;
  released: PinEvent | null;
  bol: BolCapture | null;
  status214: boolean;
  notice: NoticeReceipt | null;
  shipperConfirmation: CounterpartyConfirmation | null;
}

export type Confidence = "high" | "medium" | "low";

export interface Signal {
  name: string;
  ok: boolean;
  // True when the signal comes from a source other than the driver's own pins.
  independent?: boolean;
  detail: string;
}

export interface Corroboration {
  confidence: Confidence;
  signals: Signal[];
}

function minutesApart(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 60_000;
}

// A gap that cannot be measured (a time that does not parse) fails its check and says so.
function gapWords(gap: number): string {
  return Number.isFinite(gap) ? `${Math.round(gap)} min apart` : "a time could not be read";
}

// What ended the dock clock: the Released tap when one was recorded, else the release pin.
export function releaseEnd(record: Pick<LoadRecord, "releasedTap" | "released">): ClockEnd | null {
  return clockEndOf(record);
}

// Turns raw channel events into the clause engine's inputs. Location truth comes from the
// geofence check here, so the engine never sees a coordinate or a model-written field.
export function toLoadEvidence(record: LoadRecord, evaluatedAt: string): LoadEvidence {
  const pin = (event: PinEvent | null) =>
    event === null ? null : { at: event.serverAt, insideGeofence: checkGeofence(event.location, record.facility).inside };
  const bol: BolReading | null =
    record.bol === null
      ? null
      : { signed: record.bol.signed, checkIn: record.bol.checkIn, checkOut: record.bol.checkOut };
  // The release is timed by the tap and located by the pin; without the pin there is no release.
  const tap = record.releasedTap ?? null;
  const releasePin = pin(record.released);
  const released = releasePin && tap ? { ...releasePin, at: tap.serverAt } : releasePin;
  return {
    loadId: record.loadId,
    clauseId: record.clauseId,
    facility: record.facility.name,
    appointmentAt: record.appointmentAt,
    arrived: pin(record.arrived),
    released,
    ...(releasePin && tap ? { releasePinAt: releasePin.at } : {}),
    bol,
    status214: record.status214,
    noticeSentAt: record.notice?.sentAt ?? null,
    shipperConfirmed: record.shipperConfirmation?.confirmed ?? false,
    evaluatedAt,
  };
}

// Says how far the evidence corroborates itself. A shared location pin can be moved by the user,
// so presence is "high" only when independent signals agree with the pins.
export function corroborate(record: LoadRecord): Corroboration {
  const signals: Signal[] = [];
  for (const event of [record.arrived, record.released]) {
    if (!event) continue;
    const fence = checkGeofence(event.location, record.facility);
    signals.push({
      name: `${event.kind}_pin_in_geofence`,
      ok: fence.inside,
      detail: fence.inside ? "inside facility polygon" : `${fence.distanceMeters} m outside facility polygon`,
    });
  }
  const tap = record.releasedTap ?? null;
  if (tap && record.released) {
    // The same check the engine makes: a time that does not parse confirms nothing, and the engine
    // sends the load to a person (TIMESTAMP_UNREADABLE).
    const check = releasePinCheck(tap.serverAt, record.released.serverAt);
    signals.push({
      name: "released_pin_confirms_tap",
      ok: check === "confirmed",
      detail:
        check === "unreadable"
          ? `the pin's or the Released tap's time could not be read (limit ${RELEASE_PIN_WINDOW_MINUTES}); a person reviews the load`
          : `pin ${releasePinGapWords(tap.serverAt, record.released.serverAt)} the Released tap (limit ${RELEASE_PIN_WINDOW_MINUTES}); the clock stopped at the tap`,
    });
  }
  // The paper's out time is compared with whatever ended the clock: the tap, or on older loads the pin.
  const end = releaseEnd(record);
  const endName = end?.by ?? "released_pin";
  const endEvent = end ? { serverAt: end.at } : null;
  const bol = record.bol;
  if (bol) {
    const rcs = bol.channel === "rcs";
    const source = bol.cameraOnly ? "captured in camera-only Flow" : rcs ? "RCS photo reply; camera or gallery unknown" : "uploaded from gallery";
    signals.push({ name: "bol_camera_only", ok: bol.cameraOnly, detail: source });
    const stored = bol.pageSha256s.filter((h): h is string => h !== null);
    signals.push({
      name: "bol_media_hashed",
      ok: stored.length > 0 && stored.length === bol.pageSha256s.length,
      detail:
        bol.pageSha256s.length === 0
          ? "no photo submitted"
          : `${stored.length} of ${bol.pageSha256s.length} pages stored and hashed`,
    });
    signals.push({
      name: "bol_confirmed_by_driver",
      ok: bol.confirmedByDriver,
      detail: bol.confirmedByDriver ? "driver confirmed or corrected extracted times" : rcs ? "RCS has no form, so no driver-entered times or signed box" : "driver did not confirm times",
    });
    const pairs: Array<[string, string | null, { serverAt: string } | null, boolean]> = [
      ["bol_in_matches_arrived_pin", bol.checkIn, record.arrived, bol.timesEdited.in],
      [`bol_out_matches_${endName}`, bol.checkOut, endEvent, bol.timesEdited.out],
    ];
    for (const [name, written, event, edited] of pairs) {
      if (written === null || event === null) continue;
      const gap = minutesApart(written, event.serverAt);
      const note = edited ? "entered by the driver from the paperwork" : `pre-filled from the ${name.endsWith("_tap") ? "Released tap" : "pin"} and left unchanged, so not independent`;
      signals.push({ name, ok: gap <= BOL_TOLERANCE_MINUTES, independent: edited, detail: `${gapWords(gap)} (tolerance ${BOL_TOLERANCE_MINUTES}); ${note}` });
    }
  }
  const photo = bol?.photoReading;
  if (bol && photo) {
    signals.push({ name: "bol_photo_legible", ok: photo.legible, detail: photo.legible ? "photo read by the vision model" : "photo could not be read" });
    if (photo.legible) {
      const readPairs: Array<[string, string | null, { serverAt: string } | null]> = [
        ["bol_photo_in_matches_arrived_pin", photo.checkIn, record.arrived],
        [`bol_photo_out_matches_${endName}`, photo.checkOut, endEvent],
      ];
      for (const [name, written, event] of readPairs) {
        if (written === null || event === null) continue;
        const gap = minutesApart(written, event.serverAt);
        signals.push({ name, ok: gap <= BOL_TOLERANCE_MINUTES, independent: true, detail: `${gapWords(gap)}; written on the paper by the receiver` });
      }
      if (bol.channel === "whatsapp") {
        signals.push({ name: "bol_photo_signature_matches", ok: photo.receiverSigned === bol.signed, detail: photo.receiverSigned ? "signature visible on the photo" : "no signature visible on the photo" });
      }
    }
  }
  if (record.notice) {
    signals.push({ name: "notice_delivered", ok: record.notice.deliveredAt !== null, detail: record.notice.deliveredAt ?? "no delivery event" });
  }
  if (record.shipperConfirmation) {
    signals.push({ name: "counterparty_confirmed", ok: record.shipperConfirmation.confirmed, independent: true, detail: `via ${record.shipperConfirmation.channel}` });
  }

  const failed = signals.some((s) => !s.ok);
  const pinsPresent = record.arrived !== null && record.released !== null;
  const independent = signals.some((s) => s.ok && s.independent === true);
  const confidence: Confidence = !pinsPresent || failed ? "low" : independent ? "high" : "medium";
  return { confidence, signals };
}
