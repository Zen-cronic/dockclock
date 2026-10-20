// Renders the built judge desk with system Chrome and saves screenshots for review.
// Usage: npm run build -w @dockclock/site && npm run shots -w @dockclock/site [-- <outDir>]
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const out = process.argv[2] ?? fileURLToPath(new URL("../shots/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".pem": "application/x-pem-file" };

const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join(dist, path.endsWith("/") ? `${path}index.html` : path);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const shots = [
  ["01-first-viewport-1440", "", { width: 1440, height: 900 }, false],
  ["02-replay-full-1440", "", { width: 1440, height: 900 }, true],
  ["03-replay-midplay-1440", "?step=7", { width: 1440, height: 900 }, false],
  ["04-verify-valid-1440", "?tab=verify", { width: 1440, height: 900 }, false],
  ["05-verify-tampered-1440", "?tab=verify&tamper=amount", { width: 1440, height: 900 }, false],
  ["06-whatif-1440", "?tab=whatif&whatif=early", { width: 1440, height: 900 }, true],
  ["07-first-viewport-390", "", { width: 390, height: 844 }, false],
  ["08-replay-full-390", "", { width: 390, height: 844 }, true],
  ["09-verify-tampered-390", "?tab=verify&tamper=amount", { width: 390, height: 844 }, true],
  ["10-whatif-390", "?tab=whatif&whatif=unsigned", { width: 390, height: 844 }, true],
];

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
let failures = 0;
for (const [name, query, viewport, fullPage] of shots) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}${query}${query ? "&" : "?"}nointro`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage });
  console.log(`${name}  overflowX=${overflow}  consoleErrors=${errors.length}${errors.length ? `  ${errors.join(" | ")}` : ""}`);
  if (overflow > 0 || errors.length) failures++;
  await page.close();
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
