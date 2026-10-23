// Renders docs/architecture.source.svg (hand-drawn, Door 05 type) to:
//   docs/architecture.png, 1848px wide on white, for the README and Devpost;
//   docs/architecture.svg, the same drawing with its fonts embedded so it renders anywhere.
// Uses system Chrome via Playwright. The fonts come from Google Fonts (latin subset only).
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const SCALE = 1.2; // 1540-unit viewBox -> 1848px PNG
const FONTS_CSS =
  "https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800&family=Overpass:wght@400;600;700&family=Overpass+Mono:wght@400&display=block";
// A browser user agent, so Google Fonts serves woff2.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const docs = new URL("../docs/", import.meta.url);
const source = readFileSync(new URL("architecture.source.svg", docs), "utf8");

// Keep only the latin @font-face blocks and inline each font file as a data URI.
async function embeddedFontCss(): Promise<string> {
  const css = await (await fetch(FONTS_CSS, { headers: { "user-agent": UA } })).text();
  const blocks = [...css.matchAll(/\/\*\s*latin\s*\*\/\s*(@font-face\s*{[^}]*})/g)].map((m) => m[1]!);
  if (blocks.length < 5) throw new Error(`expected 5 latin font faces from Google Fonts, got ${blocks.length}`);
  const inlined = await Promise.all(
    blocks.map(async (block) => {
      const url = /url\((https:[^)]+\.woff2)\)/.exec(block)?.[1];
      if (!url) throw new Error(`no woff2 url in ${block}`);
      const data = Buffer.from(await (await fetch(url)).arrayBuffer()).toString("base64");
      return block.replace(url, `data:font/woff2;base64,${data}`).replace(/\s+/g, " ");
    }),
  );
  return inlined.join("\n");
}

const fontCss = await embeddedFontCss();
const standalone = source.replace("<style>", `<style>\n${fontCss}\n`);

const browser = await chromium.launch({ channel: "chrome" });
try {
  const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(source);
  if (!vb) throw new Error("architecture.source.svg needs a viewBox");
  const [width, height] = [Math.round(Number(vb[1]) * SCALE), Math.round(Number(vb[2]) * SCALE)];
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; background: #ffffff; }
      svg { display: block; width: ${width}px; height: ${height}px; }
    </style></head><body>${standalone}</body></html>`,
  );
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  // Fail rather than ship a PNG drawn in fallback fonts.
  const missing = await page.evaluate(() =>
    ['800 25px "Big Shoulders Display"', '400 16px "Overpass"', '600 15px "Overpass"', '700 14px "Overpass"', '400 13px "Overpass Mono"'].filter(
      (font) => !document.fonts.check(font),
    ),
  );
  if (missing.length) throw new Error(`fonts did not load: ${missing.join(", ")}`);

  writeFileSync(new URL("architecture.svg", docs), `<?xml version="1.0" encoding="UTF-8"?>\n${standalone}`);
  await page.locator("svg").screenshot({ path: new URL("architecture.png", docs).pathname, omitBackground: false });
  console.log(`wrote docs/architecture.svg and docs/architecture.png (${width}x${height})`);
} finally {
  await browser.close();
}
