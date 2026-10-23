import { describe, expect, it } from "vitest";
import { addressOf, buildMime, loadPageUrl, pinSource, PUBLIC_KEY_URL, renderHtml, renderText, signatureLines, type Letter } from "../src/index.js";

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
    expect(html).not.toMatch(/<img|<script|<style|<link|url\(|class=/i);
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
  });
});
