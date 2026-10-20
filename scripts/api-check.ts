// Checks the deployed console read API through CloudFront: every route answers with the contract's
// schema, nothing in any response fails findLeaks, /api/loads lists demo-workspace loads only, and a
// load outside the workspace answers 404. Read only.
// Usage: npm run api:check [-- <baseUrl>]   (default: the desk URL in .cdk-outputs.json)
import { readFileSync } from "node:fs";
import { findLeaks } from "@dockclock/sanitize";

const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const base = (process.argv[2] ?? outputs.DockClockDesk?.DeskUrl ?? "").replace(/\/$/, "");
if (!base.startsWith("https://")) throw new Error("usage: api:check <https://desk-url>");
const account = process.env.DOCKCLOCK_ACCOUNT;
let failures = 0;
const fail = (message: string) => {
  failures += 1;
  console.log(`FAIL ${message}`);
};

async function get(path: string, expected = 200): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${base}${path}`, { redirect: "manual" });
  const type = res.headers.get("content-type") ?? "";
  if (res.status !== expected) fail(`${path}: HTTP ${res.status}, expected ${expected}`);
  if (!type.includes("application/json")) {
    if (res.status === 200) fail(`${path}: content-type ${type}`);
    return null;
  }
  const body = (await res.json()) as Record<string, unknown>;
  if (body.schema !== "dockclock.api/1") fail(`${path}: schema ${String(body.schema)}`);
  const leaks = findLeaks(body, account);
  if (leaks.length) fail(`${path}: ${leaks.length} leak finding(s) at ${leaks.slice(0, 5).map((l) => l.replace(/^.* at /, "")).join(", ")}`);
  console.log(`${res.status} ${path}${leaks.length ? "" : " clean"} (x-cache ${res.headers.get("x-cache") ?? "-"})`);
  return body;
}

await get("/api/overview");
const list = await get("/api/loads?limit=100");
const loads = ((list?.data as { loads?: Array<{ loadId: string; runKind: string }> } | undefined)?.loads ?? []);
for (const load of loads) if (!/^(SMOKE|DEMO|LIVE)-/.test(load.loadId)) fail(`unexpected load id ${load.loadId}`);
console.log(`  ${loads.length} demo-workspace loads: ${[...new Set(loads.map((l) => l.runKind))].join(", ")}`);
await get("/api/messages");
await get("/api/messages?channel=rcs");
for (const { loadId } of loads.slice(0, 12)) {
  const view = await get(`/api/loads/${loadId}`);
  const data = view?.data as { pack?: unknown; emails?: Array<{ id: string }>; photos?: Array<{ url: string | null }> } | undefined;
  if (data?.pack) await get(`/api/loads/${loadId}/pack`);
  for (const email of data?.emails ?? []) await get(`/api/loads/${loadId}/emails/${email.id}`);
  for (const photo of data?.photos ?? []) {
    if (!photo.url) continue;
    const res = await fetch(`${base}${photo.url}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200 || !/^image\//.test(res.headers.get("content-type") ?? "")) fail(`${photo.url}: HTTP ${res.status} ${res.headers.get("content-type")}`);
    else if (bytes.toString("latin1").includes("Exif")) fail(`${photo.url}: EXIF still present`);
    else console.log(`200 ${photo.url} image, no EXIF, original sha256 ${res.headers.get("x-dockclock-original-sha256")?.slice(0, 12)}…`);
  }
}
// An operator load that is not in the demo workspace, and a made-up one.
for (const id of ["LIVE-mve0rrez", "LIVE-not-a-load"]) await get(`/api/loads/${id}`, 404);
console.log(failures ? `API CHECK FAIL (${failures})` : "API CHECK PASS");
process.exit(failures ? 1 : 0);
