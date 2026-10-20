// Renders the built console with system Chrome and saves screenshots of every route.
// Usage: npm run build -w @dockclock/site && npm run shots -w @dockclock/site [-- <outDir>]
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const out = process.argv[2] ?? fileURLToPath(new URL("../shots/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".pem": "application/x-pem-file", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".jpg": "image/jpeg" };

// Like the CloudFront function: a path without an extension serves index.html.
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = extname(path) ? join(dist, path) : join(dist, "index.html");
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = process.env.BASE ?? `http://127.0.0.1:${server.address().port}`;

const routes = [
  ["overview", "/"],
  ["messages", "/messages"],
  ["loads", "/loads"],
  ["load-timeline", "/loads/SMOKE-DEMO-mvh3xsdv"],
  ["load-conversation", "/loads/SMOKE-DEMO-mvh3xsdv/conversation"],
  ["load-agent", "/loads/SMOKE-DEMO-mvh3xsdv/agent"],
  ["load-evidence", "/loads/SMOKE-DEMO-mvh3xsdv/evidence"],
  ["load-whatif", "/loads/SMOKE-DEMO-mvh3xsdv/whatif"],
  ["load-progress", "/loads/SMOKE-DEMO-mvh3xsdv?stage=at_dock"],
  ["load-rcs-conversation", "/loads/SMOKE-DEMO-mvh3xsdq/conversation"],
  ["load-rcs-evidence", "/loads/SMOKE-DEMO-mvh3xsdq/evidence"],
  ["judges-start", "/judges"],
  ["judges-proved", "/judges/proved"],
  ["judges-filed", "/judges/filed"],
  ["judges-break", "/judges/break"],
  ["judges-rcs-proved", "/judges/proved?lane=rcs"],
];
const viewports = [["1440", { width: 1440, height: 900 }], ["390", { width: 390, height: 844 }]];

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
let failures = 0;
for (const [vw, viewport] of viewports) {
  for (const [name, path] of routes) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.screenshot({ path: join(out, `${name}-${vw}.png`), fullPage: false });
    console.log(`${name}-${vw}  overflowX=${overflow}  consoleErrors=${errors.length}${errors.length ? `  ${errors.join(" | ")}` : ""}`);
    if (overflow > 0 || errors.length) failures++;
    await page.close();
  }
}
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
