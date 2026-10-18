export interface FlowPhoto {
  mediaId: string;
  mimeType: string;
  metaSha256: string | null;
}

import { LOAD_ID_PATTERN, NONCE_PATTERN } from "./payload.js";

export interface ReleaseFlowResponse {
  flowToken: string;
  photos: FlowPhoto[];
  inTime: string | null;
  outTime: string | null;
  delayReason: string | null;
  consignee: string | null;
  receiverSigned: boolean;
  shareConsent: boolean;
}

export const DELAY_REASONS = ["dock_not_ready", "paperwork", "slow_unloading", "appointment_moved", "other", "none"] as const;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Reads the release Flow's completion payload. Photos arrive as media ids that download like any
// WhatsApp image; everything else is a typed form field, never free text the agent has to interpret.
export function parseReleaseFlow(responseJson: string): ReleaseFlowResponse | null {
  let data: Record<string, unknown>;
  try {
    // Media ids arrive as bare JSON numbers; quote them first so long ids keep every digit.
    data = JSON.parse(responseJson.replace(/"(id|media_id)"\s*:\s*(\d+)/g, '"$1":"$2"')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const flowToken = text(data.flow_token);
  if (!flowToken) return null;
  const rawPhotos = Array.isArray(data.bol_photo) ? (data.bol_photo as Array<Record<string, unknown>>) : [];
  const photos = rawPhotos
    .map((p) => ({ mediaId: text(p.id) ?? text(p.media_id), mimeType: text(p.mime_type) ?? "image/jpeg", metaSha256: text(p.sha256) }))
    .filter((p): p is FlowPhoto => p.mediaId !== null);
  const reason = text(data.delay_reason);
  return {
    flowToken,
    photos,
    inTime: text(data.in_time),
    outTime: text(data.out_time),
    delayReason: reason && (DELAY_REASONS as readonly string[]).includes(reason) ? reason : null,
    consignee: text(data.consignee),
    receiverSigned: data.receiver_signed === true || data.receiver_signed === "true",
    shareConsent: data.share_consent === true || data.share_consent === "true",
  };
}

export function encodeFlowToken(loadId: string, nonce: string): string {
  return ["dc1", "release", loadId, nonce].join(".");
}

export function parseFlowToken(token: string): { loadId: string; nonce: string } | null {
  const parts = token.split(".");
  const [prefix, kind, loadId, nonce] = parts;
  if (parts.length !== 4 || prefix !== "dc1" || kind !== "release" || !loadId || !nonce) return null;
  if (!LOAD_ID_PATTERN.test(loadId) || !NONCE_PATTERN.test(nonce)) return null;
  return { loadId, nonce };
}
