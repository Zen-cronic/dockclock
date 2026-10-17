import { createHash } from "node:crypto";
import type { Evaluation } from "@dockclock/clause-engine";
import type { Channel, Corroboration, LoadRecord } from "./events.js";

export interface EvidencePack {
  version: 1;
  packId: string;
  loadId: string;
  clauseId: string;
  channel: Channel;
  facility: { id: string; name: string };
  appointmentAt: string;
  events: {
    arrived: { serverAt: string; messageId: string } | null;
    released: { serverAt: string; messageId: string } | null;
    bol: { serverAt: string; messageId: string; mediaSha256: string | null; cameraOnly: boolean } | null;
    notice: { sentAt: string; deliveredAt: string | null; messageId: string } | null;
  };
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

export function buildPack(
  record: LoadRecord,
  corroboration: Corroboration,
  evaluation: Evaluation,
  sealedAt: string,
): EvidencePack {
  const channel: Channel = record.arrived?.channel ?? record.released?.channel ?? record.bol?.channel ?? "whatsapp";
  return {
    version: 1,
    packId: `${record.loadId}-${sha256Hex(`${record.loadId}|${sealedAt}`).slice(0, 12)}`,
    loadId: record.loadId,
    clauseId: record.clauseId,
    channel,
    facility: { id: record.facility.id, name: record.facility.name },
    appointmentAt: record.appointmentAt,
    events: {
      arrived: record.arrived && { serverAt: record.arrived.serverAt, messageId: record.arrived.messageId },
      released: record.released && { serverAt: record.released.serverAt, messageId: record.released.messageId },
      bol: record.bol && {
        serverAt: record.bol.serverAt,
        messageId: record.bol.messageId,
        mediaSha256: record.bol.mediaSha256,
        cameraOnly: record.bol.cameraOnly,
      },
      notice: record.notice && { ...record.notice },
    },
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
