import { createHash } from "node:crypto";
import type { Evaluation } from "@dockclock/clause-engine";
import { releaseEnd, type Channel, type Corroboration, type LoadRecord } from "./events.js";
import { checkGeofence } from "./geofence.js";

// Version 2 (2026-10-23) records the driver's Released tap, which ends the dock clock, apart from
// the release pin that confirms it, and says which of the two ended the clock. Version 1 packs have
// neither field: their release is the pin. Both verify the same way.
export const PACK_VERSION = 2;

export interface EvidencePack {
  version: 1 | 2;
  packId: string;
  loadId: string;
  clauseId: string;
  channel: Channel;
  facility: { id: string; name: string };
  appointmentAt: string;
  events: {
    arrived: { serverAt: string; messageId: string } | null;
    // v2: the Released tap (WhatsApp button or RCS suggested reply); null when none was recorded.
    releasedTap?: { serverAt: string; channel: Channel; messageId: string } | null;
    // The release location pin; v2 adds whether it was inside the facility.
    released: { serverAt: string; messageId: string; insideGeofence?: boolean } | null;
    bol: { serverAt: string; messageId: string; pageSha256s: Array<string | null>; cameraOnly: boolean; timesEdited: { in: boolean; out: boolean } } | null;
    notice: { sentAt: string; deliveredAt: string | null; messageId: string } | null;
  };
  // v2: what stopped the dock clock and when.
  clockEnd?: { by: "released_tap" | "released_pin"; at: string } | null;
  corroboration: Corroboration;
  evaluation: Evaluation;
  sealedAt: string;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Deterministic JSON: object keys sorted at every level, so the same pack always hashes the same.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

// A message id as it appears in a pack: a short sha256 reference, never the raw id. A WhatsApp
// wamid base64-encodes the sender's phone number, so a published pack must not carry it. Whoever
// holds the full id (it stays in DynamoDB) can recompute the reference and match the two.
export function messageRef(id: string): string {
  return id.startsWith("msg-sha256:") ? id : `msg-sha256:${sha256Hex(id).slice(0, 16)}`;
}

export function buildPack(
  record: LoadRecord,
  corroboration: Corroboration,
  evaluation: Evaluation,
  sealedAt: string,
): EvidencePack {
  const channel: Channel = record.arrived?.channel ?? record.released?.channel ?? record.bol?.channel ?? "whatsapp";
  const tap = record.releasedTap ?? null;
  return {
    version: PACK_VERSION,
    packId: `${record.loadId}-${sha256Hex(`${record.loadId}|${sealedAt}`).slice(0, 12)}`,
    loadId: record.loadId,
    clauseId: record.clauseId,
    channel,
    facility: { id: record.facility.id, name: record.facility.name },
    appointmentAt: record.appointmentAt,
    events: {
      arrived: record.arrived && { serverAt: record.arrived.serverAt, messageId: messageRef(record.arrived.messageId) },
      releasedTap: tap && { serverAt: tap.serverAt, channel: tap.channel, messageId: messageRef(tap.messageId) },
      released: record.released && {
        serverAt: record.released.serverAt,
        messageId: messageRef(record.released.messageId),
        insideGeofence: checkGeofence(record.released.location, record.facility).inside,
      },
      bol: record.bol && {
        serverAt: record.bol.serverAt,
        messageId: messageRef(record.bol.messageId),
        pageSha256s: record.bol.pageSha256s,
        cameraOnly: record.bol.cameraOnly,
        timesEdited: record.bol.timesEdited,
      },
      notice: record.notice && { ...record.notice, messageId: messageRef(record.notice.messageId) },
    },
    clockEnd: releaseEnd(record),
    corroboration,
    evaluation,
    sealedAt,
  };
}

export function packBytes(pack: EvidencePack): Buffer {
  return Buffer.from(canonicalJson(pack), "utf8");
}

export function packDigest(pack: EvidencePack): string {
  return sha256Hex(packBytes(pack));
}
