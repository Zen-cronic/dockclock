// Writes the console's API fixtures (site/fixtures/api/) by running the real read API handler, in
// process, against the deployed table and buckets. So every fixture is exactly what the API returns
// for a recorded demo-workspace load, already through its sanitizer and leak check.
// Usage: npm run api:fixtures -- <loadId> [<loadId> ...]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { findLeaks } from "@dockclock/sanitize";

const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const manifest = JSON.parse(readFileSync(new URL("../docs/evidence/MANIFEST.json", import.meta.url), "utf8")) as { publicKey: { spkiSha256: string } };
const messaging = outputs.DockClockMessaging!;
Object.assign(process.env, {
  TABLE_NAME: messaging.TableName,
  EVIDENCE_BUCKET: messaging.EvidenceBucket,
  MEDIA_BUCKET: messaging.RcsMediaBucket,
  EVIDENCE_SPKI_SHA256: manifest.publicKey.spkiSha256,
  ACCOUNT_ID: process.env.DOCKCLOCK_ACCOUNT ?? "",
  ...(process.env.DOCKCLOCK_DEMO_FACILITY ? { DEMO_FACILITY: process.env.DOCKCLOCK_DEMO_FACILITY } : {}),
});
const { handler } = await import("../services/api/handler.js");

const loadIds = process.argv.slice(2);
if (!loadIds.length) throw new Error("usage: api:fixtures <loadId> [<loadId> ...]");
const dir = new URL("../site/fixtures/api/", import.meta.url);
rmSync(new URL("loads/", dir), { recursive: true, force: true });
rmSync(new URL("photos/", dir), { recursive: true, force: true });
mkdirSync(new URL("loads/", dir), { recursive: true });
mkdirSync(new URL("photos/", dir), { recursive: true });

const index: Array<{ file: string; route: string; status: number }> = [];
async function get(route: string) {
  const [rawPath, rawQueryString = ""] = route.split("?");
  return handler({ rawPath: rawPath!, rawQueryString, requestContext: { http: { method: "GET" } } });
}
function write(file: string, route: string, status: number, body: unknown) {
  const leaks = findLeaks(body, process.env.ACCOUNT_ID);
  if (leaks.length) throw new Error(`${route}: ${leaks.join("; ")}`);
  writeFileSync(new URL(file, dir), `${JSON.stringify(body, null, 1)}\n`);
  index.push({ file, route, status });
  console.log(`${status} ${route} -> ${file}`);
}
async function fixture(route: string, file: string, rewrite?: (body: Record<string, unknown>) => void) {
  const res = await get(route);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  rewrite?.(body);
  write(file, route, res.statusCode, body);
  return body;
}

await fixture("/api/overview", "overview.json");
await fixture("/api/loads?limit=50", "loads.json");
await fixture("/api/messages?limit=100", "messages.json");
await fixture("/api/messages?channel=rcs&limit=50", "messages.rcs.json");
for (const loadId of loadIds) {
  const view = await fixture(`/api/loads/${loadId}`, `loads/${loadId}.json`, (body) => {
    // In fixtures, photo urls point at the copied (metadata-stripped) files.
    for (const photo of ((body.data as { photos?: Array<{ url: string | null; page: number }> }).photos ?? [])) {
      if (photo.url) photo.url = `photos/${loadId}-${photo.page}.jpg`;
    }
  });
  const data = view.data as { pack: unknown; emails: Array<{ id: string }>; photos: Array<{ page: number; url: string | null; sha256: string | null }> };
  if (data.pack) await fixture(`/api/loads/${loadId}/pack`, `loads/${loadId}.pack.json`);
  for (const email of data.emails) await fixture(`/api/loads/${loadId}/emails/${email.id}`, `loads/${loadId}.emails.${email.id}.json`);
  for (const photo of data.photos) {
    const res = await get(`/api/loads/${loadId}/photos/${photo.page}`);
    if (res.statusCode !== 200 || !res.isBase64Encoded) {
      write(`loads/${loadId}.photos.${photo.page}.error.json`, `/api/loads/${loadId}/photos/${photo.page}`, res.statusCode, JSON.parse(res.body));
      continue;
    }
    const file = `photos/${loadId}-${photo.page}.jpg`;
    writeFileSync(new URL(file, dir), Buffer.from(res.body, "base64"));
    index.push({ file, route: `/api/loads/${loadId}/photos/${photo.page}`, status: 200 });
    console.log(`200 /api/loads/${loadId}/photos/${photo.page} -> ${file} (original sha256 ${res.headers["x-dockclock-original-sha256"]})`);
  }
}
await fixture("/api/loads/LIVE-not-in-demo", "error-404.json");
writeFileSync(new URL("index.json", dir), `${JSON.stringify({ about: "Responses of the DockClock read API (site/src/api.ts) for recorded demo-workspace loads, written by npm run api:fixtures.", generatedAt: new Date().toISOString(), files: index }, null, 1)}\n`);
console.log(`wrote ${index.length} fixtures`);
