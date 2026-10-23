// Which fixture files a re-record replaces. api:fixtures rewrites a load's own files
// (loads/<id>.json, loads/<id>.<route>.json, photos/<id>-<page>.jpg) and the cross-load ones; it
// never touches another load's files or loads/live/, the in-progress captures recorded while a
// load ran, which cannot be made again.
export function staleFixtureFiles(loadIds: string[], existing: { loads: string[]; photos: string[] }): string[] {
  const ids = new Set(loadIds);
  const ownLoad = (name: string) => [...ids].some((id) => name === `${id}.json` || name.startsWith(`${id}.`));
  const ownPhoto = (name: string) => [...ids].some((id) => new RegExp(`^${id.replace(/[^A-Za-z0-9-]/g, "")}-\\d+\\.[a-z]+$`).test(name));
  return [...existing.loads.filter((n) => n.endsWith(".json") && ownLoad(n)).map((n) => `loads/${n}`), ...existing.photos.filter(ownPhoto).map((n) => `photos/${n}`)];
}

// The index after a re-record: this run's files, plus earlier entries for files still on disk.
export function mergedIndex<T extends { file: string }>(previous: T[], written: T[], stillExists: (file: string) => boolean): T[] {
  const now = new Set(written.map((w) => w.file));
  return [...previous.filter((p) => !now.has(p.file) && stillExists(p.file)), ...written].sort((a, b) => a.file.localeCompare(b.file));
}
