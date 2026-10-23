// The DockClock brand mark for outbound documents, from the one master, site/public/brand-mark.svg.
// The PDF draws BRAND_MARK_PATHS (vector, no embedded image); the email HTML shows the PNG in
// brand-mark-png.ts as an inline CID part that buildMime adds whenever the HTML references it.

export { BRAND_MARK_MASTER_SHA256, BRAND_MARK_PNG_BASE64, BRAND_MARK_PNG_SIZE } from "./brand-mark-png.js";

// The Content-ID the HTML header references (src="cid:...").
export const BRAND_MARK_CID = "brand-mark@dockclock";

// The master's shapes in its 64 x 64 viewBox (y down), in paint order. Each one is the master's
// geometry written as a filled path: the rounded rects as arcs, the three 2.5-wide door-panel
// strokes as rectangles, and the hazard stripes already cut to the bumper's clip rectangle
// (x 15 to 49, y 42 to 51).
const rounded = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}h${w}v${h}h${-w}z`;

export const BRAND_MARK_VIEWBOX = 64;
export const BRAND_MARK_PATHS: ReadonlyArray<{ d: string; fill: string }> = [
  { d: rounded(0, 0, 64, 64, 13), fill: "#ffc400" },
  { d: rounded(4.5, 4.5, 55, 55, 9), fill: "#121316" },
  { d: rounded(15, 13, 34, 29, 1.5), fill: "#ffffff" },
  { d: [20.5, 27.5, 34.5].map((y) => rect(15, y - 1.25, 34, 2.5)).join(""), fill: "#121316" },
  { d: rect(15, 42, 34, 9), fill: "#ffc400" },
  { d: "M15 51V50L23 42H29L20 51ZM26 51L35 42H41L32 51ZM38 51L47 42H49V46L44 51Z", fill: "#121316" },
];
