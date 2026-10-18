import { describe, expect, it } from "vitest";
import { COPY, LANGUAGES } from "../src/messages.js";
import { dispatchTemplate, releaseButtons } from "../src/sender.js";

describe("driver copy", () => {
  it("fits WhatsApp limits in every language", () => {
    for (const language of LANGUAGES) {
      const copy = COPY[language];
      for (const title of [copy.released, copy.talkToDispatch, copy.releaseFlowCta]) expect([...title].length, `${language}: ${title}`).toBeLessThanOrEqual(20);
      expect(copy.checkedIn("Lakeshore DC, Columbus OH", "13:52").length).toBeLessThan(1024);
      for (const text of [...Object.values(copy.replies), copy.stopped, copy.resumed]) expect(text.length).toBeGreaterThan(0);
    }
  });

  it("binds every button to the load and its nonce, and never names a recipient", () => {
    const buttons = JSON.stringify(releaseButtons("fr_CA", "4471", "abc123", "Lakeshore DC", "13:52"));
    expect(buttons).toContain("dc1.released.4471.abc123");
    expect(buttons).toContain("dc1.dispatch.4471.abc123");
    const template = dispatchTemplate("es_MX", "4471", "abc123", "Lakeshore DC", "17 oct, 2:00 p.m.") as { template: { language: { code: string } }; to?: string };
    expect(template.template.language.code).toBe("es_MX");
    expect(JSON.stringify(template)).toContain("dc1.arrived.4471.abc123");
    expect(template.to).toBeUndefined();
  });
});
