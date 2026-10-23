// Renders photo-like images of a FICTIONAL bill of lading with known contents, plus a ground-truth
// manifest, into data/bol-photos/ (gitignored). Two uses:
//   npm run bol:photos                      the eval set (see scripts/eval-bol.ts)
//   npm run bol:photos -- --in 10:05 --out 13:10 [--signer "R. Alvarez"] [--facility "Demo Yard"] [--shipper "Demo Receiving Co."]
//                                           one document matching a live load's times, to show on a
//                                           screen or print and photograph with the WhatsApp Flow camera.
// Every image carries a "fictional document" footer; none is a real shipment.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

interface BolCase {
  id: string;
  inTime: string | null;
  outTime: string | null;
  signer: string | null;
  // Defaults to the eval set's fictional shipper; a live take passes the load's counterparty.
  shipper?: string;
  facility: string;
  look: "clean" | "angled" | "dim" | "blurry";
  // What a careful reader should report.
  truth: { inTime: string | null; outTime: string | null; receiverSigned: boolean; legible: boolean };
}

const OUT_DIR = new URL("../data/bol-photos/", import.meta.url);

const EVAL_SET: BolCase[] = [
  { id: "signed-24h", inTime: "13:52", outTime: "17:18", signer: "R. Alvarez", facility: "Lakeshore DC, Columbus OH", look: "clean", truth: { inTime: "13:52", outTime: "17:18", receiverSigned: true, legible: true } },
  { id: "signed-12h", inTime: "1:52 PM", outTime: "5:18 PM", signer: "M. Okafor", facility: "Lakeshore DC, Columbus OH", look: "angled", truth: { inTime: "13:52", outTime: "17:18", receiverSigned: true, legible: true } },
  { id: "unsigned", inTime: "09:05", outTime: "12:40", signer: null, facility: "Prairie Distribution, Joliet IL", look: "clean", truth: { inTime: "09:05", outTime: "12:40", receiverSigned: false, legible: true } },
  { id: "out-missing", inTime: "08:15", outTime: null, signer: "J. Chen", facility: "Prairie Distribution, Joliet IL", look: "angled", truth: { inTime: "08:15", outTime: null, receiverSigned: true, legible: true } },
  { id: "mismatch", inTime: "13:52", outTime: "19:40", signer: "R. Alvarez", facility: "Lakeshore DC, Columbus OH", look: "clean", truth: { inTime: "13:52", outTime: "19:40", receiverSigned: true, legible: true } },
  { id: "dim-angled", inTime: "14:10", outTime: "16:55", signer: "D. Singh", facility: "Lakeshore DC, Columbus OH", look: "dim", truth: { inTime: "14:10", outTime: "16:55", receiverSigned: true, legible: true } },
  { id: "blurry", inTime: "13:52", outTime: "17:18", signer: "R. Alvarez", facility: "Lakeshore DC, Columbus OH", look: "blurry", truth: { inTime: null, outTime: null, receiverSigned: false, legible: false } },
];

const LOOKS: Record<BolCase["look"], string> = {
  clean: "transform: rotate(-2.2deg); filter: contrast(1.02);",
  angled: "transform: perspective(1400px) rotateX(9deg) rotateZ(4deg) translateY(10px);",
  dim: "transform: perspective(1400px) rotateX(6deg) rotateZ(-5deg); filter: brightness(0.72) contrast(0.92);",
  blurry: "transform: rotate(3deg); filter: blur(7px) brightness(0.95);",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

// A signature that reads as handwriting without depending on a font: a looping stroke per letter.
function signaturePath(name: string): string {
  let x = 10;
  let d = "M 8 34";
  for (const ch of name.replace(/[^A-Za-z]/g, "")) {
    const h = 12 + (ch.charCodeAt(0) % 9) * 2;
    d += ` C ${x + 4} ${34 - h}, ${x + 10} ${34 - h}, ${x + 11} 30 S ${x + 16} ${40 + (ch.charCodeAt(0) % 5)}, ${x + 20} 31`;
    x += 17;
  }
  return `<svg viewBox="0 0 ${x + 30} 56" width="${Math.min(260, x + 30)}" height="56"><path d="${d} L ${x + 26} 26" fill="none" stroke="#1b2a6b" stroke-width="2.4" stroke-linecap="round"/></svg>`;
}

function page(c: BolCase): string {
  const hand = (value: string | null) => (value ? `<span class="hand">${escapeHtml(value)}</span>` : `<span class="blank">&nbsp;</span>`);
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&display=block" rel="stylesheet">
<style>
  body { margin: 0; width: 1200px; height: 1500px; display: grid; place-items: center;
    background: radial-gradient(circle at 30% 20%, #8a6a4a, #4e3926 70%); }
  .sheet { width: 820px; background: #fbfaf6; color: #111; padding: 34px 38px; box-shadow: 0 30px 60px rgba(0,0,0,.45);
    font: 15px/1.35 Arial, Helvetica, sans-serif; ${LOOKS[c.look]} }
  h1 { font-size: 26px; letter-spacing: .04em; margin: 0 0 2px; } .sub { color: #555; margin: 0 0 14px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
  td, th { border: 1.6px solid #333; padding: 8px 9px; text-align: left; vertical-align: top; }
  th { background: #eee; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  .times td { height: 74px; } .times b { display: block; font-size: 16px; }
  .hand { font: 700 36px/1 Kalam, "Comic Sans MS", cursive; color: #1b2a6b; display: inline-block; transform: rotate(-3deg); margin-top: 4px; }
  .name { font: 400 26px/1 Kalam, cursive; color: #1b2a6b; }
  .sig td { height: 84px; }
  footer { border-top: 1px solid #333; color: #555; font-size: 11px; margin-top: 12px; padding-top: 6px; }
</style></head><body><div class="sheet">
  <h1>STRAIGHT BILL OF LADING</h1><p class="sub">BOL No. ${escapeHtml(c.id.toUpperCase())}-4471 · Short form, not negotiable</p>
  <table><tr><th>Shipper</th><th>Facility</th></tr><tr><td>${escapeHtml(c.shipper ?? "Lakeshore Foods")} (fictional shipper)</td><td>${escapeHtml(c.facility)}</td></tr>
    <tr><th>Carrier</th><th>Trailer / Seal</th></tr><tr><td>Demo Carrier (fictional, 40 trucks)</td><td>TRL 5302 / SEAL 88120</td></tr></table>
  <table><tr><th>Handling units</th><th>Description</th><th>Weight (lb)</th></tr><tr><td>22 PLT</td><td>Canned goods, dry, no hazmat</td><td>38,400</td></tr></table>
  <table class="times"><tr><th colspan="2">Dock times, written by the receiver</th></tr>
    <tr><td><b>IN</b>time ${hand(c.inTime)}</td><td><b>OUT</b>time ${hand(c.outTime)}</td></tr></table>
  <table class="sig"><tr><th>Receiver's printed name</th><th>Receiver's signature</th></tr>
    <tr><td>${c.signer ? `<span class="name">${escapeHtml(c.signer)}</span>` : ""}</td><td>${c.signer ? signaturePath(c.signer) : ""}</td></tr></table>
  <footer>Fictional document made for software testing and a demo video. Not a real shipment, shipper, carrier or contract.</footer>
</div></body></html>`;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
}

const custom = arg("in") || arg("out");
const cases: BolCase[] = custom
  ? [
      {
        id: `live-${Date.now().toString(36)}`,
        inTime: arg("in"),
        outTime: arg("out"),
        signer: arg("signer") ?? "R. Alvarez",
        facility: arg("facility") ?? "Demo Yard (operator test site)",
        shipper: arg("shipper") ?? "Lakeshore Foods",
        look: "clean",
        truth: { inTime: arg("in"), outTime: arg("out"), receiverSigned: true, legible: true },
      },
    ]
  : EVAL_SET;

mkdirSync(OUT_DIR, { recursive: true });
// Uses the installed Google Chrome, so no Playwright browser download is needed.
const browser = await chromium.launch({ channel: process.env.BOL_BROWSER_CHANNEL ?? "chrome" });
const tab = await browser.newPage({ viewport: { width: 1200, height: 1500 } });
const manifest: Array<{ file: string; mimeType: string } & Pick<BolCase, "id" | "truth">> = [];
for (const c of cases) {
  await tab.setContent(page(c), { waitUntil: "networkidle" });
  const file = `${c.id}.jpg`;
  writeFileSync(new URL(file, OUT_DIR), await tab.screenshot({ type: "jpeg", quality: 82 }));
  manifest.push({ id: c.id, file, mimeType: "image/jpeg", truth: c.truth });
  console.log(`wrote data/bol-photos/${file}`);
}
await browser.close();
if (!custom) writeFileSync(new URL("manifest.json", OUT_DIR), `${JSON.stringify(manifest, null, 2)}\n`);
