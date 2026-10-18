// Renders docs/architecture.mmd to docs/architecture.svg and docs/architecture.png (1600px wide,
// white background) with Mermaid in system Chrome via Playwright.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
const WIDTH = 1600;
const docs = new URL("../docs/", import.meta.url);
const source = readFileSync(new URL("architecture.mmd", docs), "utf8");

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: 1200 }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; background: #ffffff; }
      #out { width: ${WIDTH}px; }
      #out svg { display: block; width: ${WIDTH}px !important; max-width: none !important; height: auto; background: #ffffff; }
    </style></head><body><div id="out"></div></body></html>`,
  );
  await page.addScriptTag({ url: MERMAID_URL });

  const svgText = await page.evaluate(async (src) => {
    type Mermaid = { initialize(config: object): void; render(id: string, text: string): Promise<{ svg: string }> };
    const mermaid = (window as unknown as { mermaid: Mermaid }).mermaid;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: "16px",
        primaryColor: "#eef4ff",
        primaryBorderColor: "#3b5bdb",
        lineColor: "#495057",
        textColor: "#1a202c",
        clusterBkg: "#fafafa",
        clusterBorder: "#adb5bd",
        edgeLabelBackground: "#ffffff",
      },
      flowchart: { htmlLabels: true, curve: "basis", nodeSpacing: 28, rankSpacing: 38, padding: 10, wrappingWidth: 400 },
    });
    const { svg } = await mermaid.render("dockclock-architecture", src);
    const out = document.getElementById("out")!;
    out.innerHTML = svg;
    const el = out.querySelector("svg")!;
    el.setAttribute("style", `background-color: #ffffff; max-width: ${el.viewBox.baseVal.width}px;`);
    // A white rectangle under everything, so viewers that ignore CSS backgrounds still get white.
    const vb = el.viewBox.baseVal;
    const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    for (const [k, v] of Object.entries({ x: vb.x, y: vb.y, width: vb.width, height: vb.height, fill: "#ffffff" })) bg.setAttribute(k, String(v));
    el.insertBefore(bg, el.firstChild);
    // XMLSerializer, not outerHTML: the labels are XHTML inside foreignObject and must be well formed.
    return new XMLSerializer().serializeToString(el);
  }, source);

  writeFileSync(new URL("architecture.svg", docs), `<?xml version="1.0" encoding="UTF-8"?>\n${svgText}\n`);
  // The page CSS stretches the live SVG to WIDTH, so the element screenshot is WIDTH pixels wide.
  await page.locator("#out svg").screenshot({ path: new URL("architecture.png", docs).pathname, omitBackground: false });
  const box = await page.locator("#out svg").boundingBox();
  console.log(`wrote docs/architecture.svg and docs/architecture.png (${Math.round(box!.width)}x${Math.round(box!.height)})`);
} finally {
  await browser.close();
}
