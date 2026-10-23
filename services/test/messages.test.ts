import { describe, expect, it } from "vitest";
import { COPY, LANGUAGES } from "../src/messages.js";
import { RELEASE_PIN_WINDOW_MINUTES } from "@dockclock/clause-engine";
import { rcsLocationRequest } from "../src/rcs.js";
import { reasonWords } from "../src/reasons.js";
import { dispatchTemplate, locationRequest, releaseButtons } from "../src/sender.js";

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

  it("tells the driver after Released that the clock stopped then, and asks for the pin within the window", () => {
    expect(COPY.en_US.locationReleased("14:32 EDT")).toBe("Clock stopped at 14:32 EDT.\nShare your location within 10 minutes to confirm the release.");
    for (const language of LANGUAGES) {
      const text = COPY[language].locationReleased("14:32 EDT");
      expect(text.split("\n")[0], language).toContain("14:32 EDT");
      expect(text, language).toContain(`${RELEASE_PIN_WINDOW_MINUTES} minut`);
      // A load from before the tap was kept has no time to quote: the first line is dropped.
      expect(COPY[language].locationReleased(""), language).not.toContain("\n");
    }
    const whatsapp = locationRequest("es_MX", "released", "14:32 EDT") as { interactive: { body: { text: string } } };
    expect(whatsapp.interactive.body.text).toContain("Reloj detenido a las 14:32 EDT.");
    expect(rcsLocationRequest("fr_CA", "released", "14:32 EDT").Content?.TextMessage?.Body).toContain("Chrono arrêté à 14:32 EDT.");
  });

  it("words a late release pin plainly in every language", () => {
    expect(reasonWords(["RELEASE_PIN_LATE"], "en_US")).toBe("the release location was not shared within 10 minutes of tapping Released");
    for (const language of LANGUAGES) expect(reasonWords(["RELEASE_PIN_LATE"], language), language).not.toMatch(/RELEASE_PIN_LATE|pin late/i);
  });
});
