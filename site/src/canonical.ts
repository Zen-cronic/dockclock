// The exact bytes DockClock signs: canonical JSON of the pack (keys sorted, undefined dropped). This
// mirrors canonicalJson in packages/evidence/src/pack.ts; a test checks the two agree on a real pack.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function packBytes(pack: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(pack));
}
