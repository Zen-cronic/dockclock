import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderTemplate, TEMPLATE_TEXT } from "../src/index.js";

interface TemplateFile {
  templates: Array<{ name: string; languages: Record<string, { body: string; footer?: string; buttons?: string[] }> }>;
}

const file = JSON.parse(readFileSync(new URL("../templates.json", import.meta.url), "utf8")) as TemplateFile;

describe("template text", () => {
  it("equals the wording submitted to Meta in templates.json", () => {
    const fromFile = Object.fromEntries(
      file.templates.map((t) => [
        t.name,
        Object.fromEntries(Object.entries(t.languages).map(([language, v]) => [language, { body: v.body, ...(v.footer ? { footer: v.footer } : {}), ...(v.buttons ? { buttons: v.buttons } : {}) }])),
      ]),
    );
    expect(TEMPLATE_TEXT).toEqual(fromFile);
  });

  it("fills the numbered parameters and keeps the buttons and footer", () => {
    const out = renderTemplate("dockclock_load_dispatch", "en_US", ["4471", "Lakeshore DC", "Oct 17, 2:00 PM"]);
    expect(out?.body).toBe("Load 4471 is booked: Lakeshore DC, appointment Oct 17, 2:00 PM. When you are parked at the dock, tap Arrived and we will start the detention clock.");
    expect(out?.buttons).toEqual(["Arrived", "Talk to dispatch"]);
    expect(out?.footer).toBe("Reply STOP to stop load messages.");
    expect(renderTemplate("unknown", "en_US", [])).toBeNull();
  });
});
