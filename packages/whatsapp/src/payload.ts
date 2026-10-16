export type ButtonAction = "arrived" | "released" | "approve" | "hold" | "dispatch";

export interface ButtonPayload {
  action: ButtonAction;
  loadId: string;
  nonce: string;
}

const ACTIONS = new Set<ButtonAction>(["arrived", "released", "approve", "hold", "dispatch"]);
const PREFIX = "dc1";

// Every button DockClock sends carries the load it belongs to and a nonce, so a tap is bound to
// one load and one message and cannot be replayed onto another.
export function encodeButtonPayload(payload: ButtonPayload): string {
  return [PREFIX, payload.action, payload.loadId, payload.nonce].join(".");
}

export function parseButtonPayload(raw: string): ButtonPayload | null {
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, action, loadId, nonce] = parts;
  if (!action || !loadId || !nonce || !ACTIONS.has(action as ButtonAction)) return null;
  if (!/^[A-Za-z0-9-]{1,40}$/.test(loadId) || !/^[A-Za-z0-9]{6,32}$/.test(nonce)) return null;
  return { action: action as ButtonAction, loadId, nonce };
}
