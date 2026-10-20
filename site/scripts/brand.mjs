// Writes every brand asset from the one master mark, public/brand-mark.svg:
//   public/favicon.svg     byte-identical copy (browsers ask for /favicon.svg)
//   public/logo.svg        the mark plus the DOCKCLOCK wordmark
//   public/favicon-32.png, public/apple-touch-icon.png  raster fallbacks rendered from the master
// Usage: npm run brand -w @dockclock/site
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const pub = (f) => fileURLToPath(new URL(`../public/${f}`, import.meta.url));
const master = await readFile(pub("brand-mark.svg"), "utf8");
await writeFile(pub("favicon.svg"), master);

const inner = master.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/<title[^>]*>.*?<\/title>/, "");
await writeFile(
  pub("logo.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 264 64" role="img" aria-labelledby="dc-l">
  <title id="dc-l">DockClock</title>
  <g>${inner}</g>
  <text x="78" y="47" font-family="Big Shoulders Display, Arial Narrow, sans-serif" font-size="44" font-weight="800" textLength="178" lengthAdjust="spacingAndGlyphs" fill="#121316">DOCKCLOCK</text>
</svg>
`,
);

const browser = await chromium.launch({ channel: "chrome" });
for (const [file, size] of [["favicon-32.png", 32], ["apple-touch-icon.png", 180]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(master).toString("base64")}" width="${size}" height="${size}"></body></html>`);
  await page.screenshot({ path: pub(file), omitBackground: true });
  await page.close();
}
await browser.close();
console.log("brand assets written from public/brand-mark.svg");
