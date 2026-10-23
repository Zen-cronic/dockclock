import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addressOf, BRAND_MARK_CID, BRAND_MARK_MASTER_SHA256, BRAND_MARK_PNG_BASE64, buildMime, loadPageUrl, minutesText, pinSource, PUBLIC_KEY_URL, renderHtml, renderText, signatureLines, type Letter } from "../src/index.js";

const letter: Letter = {
  kind: "Detention notice",
  salutation: "Dear Atlas <Brokerage> & Co.,",
  summary: "Load 4471 is still at the dock.",
  facts: [
    { label: "Load", value: "4471" },
    { label: "Amount due", value: "$1.00", strong: true },
  ],
  closing: "Please release the truck.",
  signature: signatureLines("DockClock Claims <claims@example.com>", "dispatch@example.com"),
  links: [{ label: "Public key", href: PUBLIC_KEY_URL }],
  notes: ["The carrier, the counterparty and the facility are fictional."],
};

describe("letter layout", () => {
  it("renders plain text as label: value lines with the signature and footer last", () => {
    expect(renderText(letter)).toBe(
      [
        "Dear Atlas <Brokerage> & Co.,",
        "",
        "Load 4471 is still at the dock.",
        "",
        "Load: 4471",
        "Amount due: $1.00",
        "",
        "Please release the truck.",
        "",
        "DockClock Claims, on behalf of Demo Carrier (fictional)",
        "claims@example.com",
        "Reply to this email to reach the carrier's dispatch desk.",
        "",
        `Public key: ${PUBLIC_KEY_URL}`,
        "The carrier, the counterparty and the facility are fictional.",
      ].join("\n"),
    );
  });

  it("renders HTML with tables and inline styles only, escaping every value", () => {
    const html = renderHtml(letter, "Subject <x>");
    expect(html).toContain("Dear Atlas &lt;Brokerage&gt; &amp; Co.,");
    expect(html).toContain("<title>Subject &lt;x&gt;</title>");
    expect(html).toContain('role="presentation"');
    expect(html).toContain("#ffc400");
    expect(html).toContain(`href="${PUBLIC_KEY_URL}"`);
    expect(html).not.toMatch(/<script|<style|<link|url\(|class=/i);
    // The one image is the brand mark, referenced by Content-ID: nothing is fetched from a server.
    expect([...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1])).toEqual([`cid:${BRAND_MARK_CID}`]);
    expect(html).toMatch(/font-weight:bold;[^"]*">\$1\.00</);
  });

  it("drops the reply line when the message has no Reply-To", () => {
    expect(signatureLines("claims@example.com", undefined)).toEqual(["DockClock Claims, on behalf of Demo Carrier (fictional)", "claims@example.com"]);
    expect(addressOf("DockClock Claims <claims@example.com>")).toBe("claims@example.com");
  });

  it("links the console only for demo-workspace loads", () => {
    expect(loadPageUrl("LIVE-abc", "demo")).toBe("https://d3djuoqhg6b8o2.cloudfront.net/loads/LIVE-abc");
    expect(loadPageUrl("LIVE-abc", undefined)).toBeNull();
  });

  it("never claims a geofence on the judge demo yard or a server time on a test load", () => {
    expect(pinSource({ synthetic: false, channel: "whatsapp", anyLocation: true, insideGeofence: true, pins: 1 })).toBe("Location pin recorded with WhatsApp server time; the demo yard accepts any location");
    expect(pinSource({ synthetic: true, channel: "whatsapp", anyLocation: false, insideGeofence: true, pins: 2 })).toBe("Synthetic test pins (test load)");
    expect(pinSource({ synthetic: false, channel: "rcs", anyLocation: false, insideGeofence: null, pins: 1 })).toBe("Location pin recorded with RCS server time");
  });
});

describe("buildMime", () => {
  it("sends text then HTML as multipart/alternative, with a date and an encoded subject", () => {
    const raw = buildMime({ from: "a@example.com", to: "b@example.com", replyTo: "c@example.com", subject: "Détention", date: new Date("2026-10-23T18:57:00Z"), text: "Plain", html: "<p>HTML</p>" }, "b1");
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="b1-alt"');
    expect(raw).not.toContain("multipart/mixed");
    expect(raw).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    expect(raw).toMatch(/^Date: Fri, 23 Oct 2026 18:57:00 GMT\r$/m);
    expect(raw).toMatch(/^Reply-To: c@example\.com\r$/m);
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"));
    expect(raw.trimEnd().endsWith("--b1-alt--")).toBe(true);
    // No brand mark in the HTML, so no related part.
    expect(raw).not.toContain("multipart/related");
  });

  it("carries the brand mark the HTML header shows as an inline related part, not an attachment", () => {
    const html = renderHtml(letter, "Subject");
    const raw = buildMime({ from: "a@example.com", to: "b@example.com", subject: "S", date: new Date("2026-10-23T18:57:00Z"), text: renderText(letter), html }, "b1");
    // text/plain first, then a multipart/related holding the HTML and the mark.
    expect(raw).toContain('Content-Type: multipart/related; type="text/html"; boundary="b1-rel"');
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("multipart/related"));
    expect(raw.indexOf("multipart/related")).toBeLessThan(raw.indexOf("text/html"));
    const part = /--b1-rel\r\nContent-Type: image\/png\r\n([\s\S]*?)\r\n\r\n([A-Za-z0-9+/=\r\n]+)--b1-rel--/.exec(raw);
    expect(part).not.toBeNull();
    expect(part![1]).toBe(`Content-Transfer-Encoding: base64\r\nContent-ID: <${BRAND_MARK_CID}>\r\nContent-Disposition: inline`);
    // No file name anywhere on the part, so clients do not list it with the attachments.
    expect(part![1]).not.toMatch(/name=/i);
    const png = Buffer.from(part![2]!.replace(/\s+/g, ""), "base64");
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(png.length).toBeLessThan(8_000);
    expect(raw.trimEnd().endsWith("--b1-alt--")).toBe(true);
  });
});

describe("brand mark", () => {
  it("was generated from the console's master mark (rerun npm run brand:mail and check brand.ts if this fails)", () => {
    const master = readFileSync(new URL("../../../site/public/brand-mark.svg", import.meta.url));
    expect(createHash("sha256").update(master).digest("hex")).toBe(BRAND_MARK_MASTER_SHA256);
    expect(Buffer.from(BRAND_MARK_PNG_BASE64, "base64").length).toBeLessThan(8_000);
  });
});

describe("minutes in formal copy", () => {
  it("drops decimals on whole minutes and gives seconds only for a fraction", () => {
    expect(minutesText(3)).toBe("3 minutes");
    expect(minutesText(1)).toBe("1 minute");
    expect(minutesText(0)).toBe("0 minutes");
    expect(minutesText(1.5)).toBe("1 minute 30 seconds");
    expect(minutesText(90.99)).toBe("90 minutes 59 seconds");
    expect(minutesText(17.28)).toBe("17 minutes 17 seconds");
    expect(minutesText(0.5)).toBe("30 seconds");
    expect(minutesText(2.9999)).toBe("3 minutes");
  });
});
