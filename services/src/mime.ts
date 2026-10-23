// Where a load's emails are kept: next to its signed packs, under the same Object Lock retention.
export function emailKey(loadId: string, kind: "notice" | "claim"): string {
  return `packs/${loadId}/${kind}.eml`;
}
