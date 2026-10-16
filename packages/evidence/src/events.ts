import type { BolReading, LoadEvidence } from "@dockclock/clause-engine";
import { BOL_TOLERANCE_MINUTES } from "@dockclock/clause-engine";
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

export interface BolCapture {
  channel: Channel;
  messageId: string;
  serverAt: string;
  cameraOnly: boolean;
  mediaSha256: string;
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
  detail: string;
}

export interface Corroboration {
  confidence: Confidence;
  signals: Signal[];
}

function minutesApart(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 60_000;
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
  return {
    loadId: record.loadId,
    clauseId: record.clauseId,
    facility: record.facility.name,
    appointmentAt: record.appointmentAt,
    arrived: pin(record.arrived),
    released: pin(record.released),
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
  const bol = record.bol;
  if (bol) {
    signals.push({ name: "bol_camera_only", ok: bol.cameraOnly, detail: bol.cameraOnly ? "captured in camera-only Flow" : "uploaded from gallery" });
    signals.push({ name: "bol_confirmed_by_driver", ok: bol.confirmedByDriver, detail: "driver confirmed or corrected extracted times" });
    const pairs: Array<[string, string | null, PinEvent | null]> = [
      ["bol_in_matches_arrived_pin", bol.checkIn, record.arrived],
      ["bol_out_matches_released_pin", bol.checkOut, record.released],
    ];
    for (const [name, written, event] of pairs) {
      if (written === null || event === null) continue;
      const gap = minutesApart(written, event.serverAt);
      signals.push({ name, ok: gap <= BOL_TOLERANCE_MINUTES, detail: `${Math.round(gap)} min apart (tolerance ${BOL_TOLERANCE_MINUTES})` });
    }
  }
  if (record.notice) {
    signals.push({ name: "notice_delivered", ok: record.notice.deliveredAt !== null, detail: record.notice.deliveredAt ?? "no delivery event" });
  }
  if (record.shipperConfirmation) {
    signals.push({ name: "counterparty_confirmed", ok: record.shipperConfirmation.confirmed, detail: `via ${record.shipperConfirmation.channel}` });
  }

  const failed = signals.some((s) => !s.ok);
  const pinsPresent = record.arrived !== null && record.released !== null;
  const independent = signals.some(
    (s) => s.ok && (s.name.startsWith("bol_in") || s.name.startsWith("bol_out") || s.name === "counterparty_confirmed"),
  );
  const confidence: Confidence = !pinsPresent || failed ? "low" : independent ? "high" : "medium";
  return { confidence, signals };
}
