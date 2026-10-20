// Watches one load through the read API handler (in process, against the deployed table) and keeps
// the first view at each new status, to show a load moving through its phases and to capture
// in-progress fixtures. Usage: npm run api:watch -- <loadId> <outDir> [seconds]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
const [loadId, outDir, seconds = "240"] = process.argv.slice(2);
if (!loadId || !outDir) throw new Error("usage: api:watch <loadId> <outDir> [seconds]");
mkdirSync(outDir, { recursive: true });
const seen = new Set<string>();
const until = Date.now() + Number(seconds) * 1000;
while (Date.now() < until) {
  const res = await handler({ rawPath: `/api/loads/${loadId}`, requestContext: { http: { method: "GET" } } });
  if (res.statusCode === 200) {
    const body = JSON.parse(res.body) as { data: { summary: { status: string; phase: string; live: boolean } } };
    const { status, phase, live } = body.data.summary;
    if (!seen.has(status)) {
      seen.add(status);
      writeFileSync(`${outDir}/${loadId}.${status}.json`, `${JSON.stringify(body, null, 1)}\n`);
      console.log(`${new Date().toISOString()} ${loadId}: ${status} (phase ${phase})`);
    }
    if (!live) break;
  } else console.log(`${new Date().toISOString()} ${loadId}: HTTP ${res.statusCode}`);
  await new Promise((r) => setTimeout(r, 1500));
}
