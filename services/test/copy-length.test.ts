import { describe, expect, it } from "vitest";
import { approvalSummary, APPROVAL_REPLY } from "../src/approval.js";
import { DEMO_INTRO, DEMO_LIMIT_TEXT } from "../src/demo.js";
import { escalationEmail } from "../src/escalate.js";
import { COPY, LANGUAGES, type Language } from "../src/messages.js";
import { noticeEmail } from "../src/notice.js";
import { outcomeText } from "../src/outcome.js";
import { rcsBolRequest, rcsDispatchCard, rcsReleaseOffer } from "../src/rcs.js";
import type { LoadItem } from "../src/store.js";

// Drivers read these on a phone at the dock. Every free-form message (sent inside the 24-hour
// window, so not one of the approved templates) is filled with long, realistic values and held to a
// length a phone shows without scrolling. A failure here means a message grew: cut it, or give it
// its own reasoned cap below.
const PHONE_SIZED = 320;
// The judge demo's intro is the one message that has to carry steps and disclosures together: the
// four steps, that the contract is fictional and emails go to a test mailbox, the daily limit and
// what is stored. It gets its own cap, in short lines.
const DEMO_INTRO_CAP = 760;
const FACILITY = "Lakeshore Distribution Center, Columbus OH";
const COUNTERPARTY = "Atlas Brokerage (fictional broker)";
const LOAD = "LIVE-mvheu9rl";
const ALL_REASONS = ["PIN_OUTSIDE_GEOFENCE", "BOL_TIMESTAMP_CONFLICT", "NOTICE_LATE"];

function driverMessages(language: Language): Record<string, string> {
  const copy = COPY[language];
  const extra = { counterparty: COUNTERPARTY, digest: "c47e0e473434a54d40595055924262f3716dd90ab74bfb135d2b19b0ac5e83a4", amountUsd: 1234.56 };
  const out = (input: Parameters<typeof outcomeText>[0], demo = false) => outcomeText(input, language, demo, extra);
  const messages: Record<string, string> = {
    locationArrived: copy.locationArrived,
    locationReleased: copy.locationReleased,
    checkedIn: copy.checkedIn(FACILITY, "14:25 EDT"),
    releaseFlowBody: copy.releaseFlowBody(FACILITY, "16:02 EDT"),
    retakeAsk: copy.retakeAsk(60, "17:10", "EDT", false),
    noticeSent: copy.noticeSent(LOAD, "14:21 EDT", COUNTERPARTY),
    stopped: copy.stopped,
    resumed: copy.resumed,
    rcsDispatch: copy.rcs.dispatch(FACILITY, "Oct 17, 2:00 PM"),
    rcsBolRequest: copy.rcs.bolRequest(FACILITY, "16:02 EDT"),
    billable: out({ kind: "verdict", loadId: LOAD, verdict: "BILLABLE", amountUsd: 1234.56, reasons: [] }, true),
    notBillable: out({ kind: "verdict", loadId: LOAD, verdict: "NOT_BILLABLE", amountUsd: 0, reasons: ["NO_STATEMENT_OF_RECORD", "NOTICE_MISSING"] }),
    needsHuman: out({ kind: "verdict", loadId: LOAD, verdict: "NEEDS_HUMAN", amountUsd: 0, reasons: ALL_REASONS }),
    filed: out({ kind: "filed", loadId: LOAD }),
    held: out({ kind: "held", loadId: LOAD }),
  };
  for (const [key, text] of Object.entries(copy.replies)) messages[`reply.${key}`] = text;
  return messages;
}

describe("driver messages are phone-sized", () => {
  it(`keeps every en_US free-form driver message within ${PHONE_SIZED} characters`, () => {
    const messages = {
      ...driverMessages("en_US"),
      approved: APPROVAL_REPLY.approved(LOAD),
      held: APPROVAL_REPLY.held(LOAD),
      already: APPROVAL_REPLY.already(LOAD, "approved"),
      demoLimit: DEMO_LIMIT_TEXT,
    };
    for (const [key, text] of Object.entries(messages)) expect(text.length, `${key}: ${text}`).toBeLessThanOrEqual(PHONE_SIZED);
  });

  it("keeps the Spanish and French versions within a fifth of that (they run longer)", () => {
    for (const language of LANGUAGES) {
      for (const [key, text] of Object.entries(driverMessages(language))) expect(text.length, `${language} ${key}: ${text}`).toBeLessThanOrEqual(PHONE_SIZED * 1.2);
    }
  });

  it("leads every multi-line message with a line short enough to read at a glance", () => {
    for (const language of LANGUAGES) {
      for (const [key, text] of Object.entries(driverMessages(language))) if (text.includes("\n")) expect(text.split("\n")[0]!.length, `${language} ${key}`).toBeLessThanOrEqual(140);
    }
  });

  it(`holds the demo intro to ${DEMO_INTRO_CAP} characters, in lines, with every disclosure`, () => {
    for (const language of LANGUAGES) {
      const intro = DEMO_INTRO[language];
      expect(intro.length, language).toBeLessThanOrEqual(language === "en_US" ? DEMO_INTRO_CAP : DEMO_INTRO_CAP * 1.2);
      for (const line of intro.split("\n")) expect(line.length, `${language}: ${line}`).toBeLessThanOrEqual(180);
      expect(intro.split("\n").length, language).toBeGreaterThanOrEqual(6);
      expect(intro, language).toMatch(/00(:| h )00 UTC/);
    }
    expect(DEMO_INTRO.en_US).toContain("The contract and receiver are fictional");
    expect(DEMO_INTRO.en_US).toContain("test mailbox");
  });

  it("keeps internal terms out of what drivers and dispatchers read", () => {
    const internal = /evidence confidence|verdict|digest|pack id|NEEDS_HUMAN|BILLABLE|server time/i;
    for (const language of LANGUAGES) {
      for (const [key, text] of Object.entries(driverMessages(language))) expect(text, `${language} ${key}`).not.toMatch(internal);
    }
    for (const confidence of ["high", "medium", "low", undefined]) {
      for (const legible of [true, false, null]) expect(approvalSummary(confidence, legible)).not.toMatch(internal);
    }
  });
});

describe("WhatsApp and RCS limits", () => {
  it("fits interactive bodies in 1024 characters and buttons and the Flow CTA in 20", () => {
    for (const language of LANGUAGES) {
      const copy = COPY[language];
      for (const body of [copy.checkedIn(FACILITY, "14:25 EDT"), copy.releaseFlowBody(FACILITY, "16:02 EDT"), copy.locationArrived, copy.locationReleased]) expect(body.length).toBeLessThanOrEqual(1024);
      for (const title of [copy.released, copy.talkToDispatch, copy.releaseFlowCta]) expect([...title].length, `${language}: ${title}`).toBeLessThanOrEqual(20);
    }
  });

  it("fits RCS cards: title 200, description 2000, suggestion text 25", () => {
    for (const language of LANGUAGES) {
      for (const content of [rcsDispatchCard(language, LOAD, "n1", FACILITY, "Oct 17, 2:00 PM"), rcsReleaseOffer(language, LOAD, "n1", FACILITY, "14:25 EDT")]) {
        const card = content.Content!.RichCard!.CardContent!;
        expect(card.Title!.length).toBeLessThanOrEqual(200);
        expect(card.Description!.length).toBeLessThanOrEqual(2000);
        for (const s of card.Suggestions ?? []) expect([...(s.Reply?.Text ?? "")].length).toBeLessThanOrEqual(25);
      }
      expect(rcsBolRequest(language, FACILITY, "16:02 EDT").Content!.TextMessage!.Body!.length).toBeLessThanOrEqual(PHONE_SIZED * 1.2);
    }
  });

  it("fits the approval template's summary parameter on one short line", () => {
    for (const confidence of ["high", "medium", "low", undefined]) {
      for (const legible of [true, false, null]) {
        const summary = approvalSummary(confidence, legible);
        expect(summary.length).toBeLessThanOrEqual(80);
        expect(summary).not.toMatch(/\n|\t| {4}/);
      }
    }
  });
});

describe("emails lead with what they are", () => {
  const load = {
    loadId: LOAD,
    clauseId: "atlas-brokerage",
    facilityId: "lakeshore-columbus",
    phase: "sealed",
    language: "es_MX",
    channel: "whatsapp",
    address: { kind: "phone", e164: "+15550100001" },
    arrived: { serverAt: "2026-10-20T15:28:00.000Z" },
    released: { serverAt: "2026-10-20T19:06:00.000Z" },
  } as unknown as LoadItem;

  it("gives the escalation a plain subject and a first line that says what to do", () => {
    const { subject, text } = escalationEmail(load, "no approval within two days; nothing was sent", { pack: { confidence: "medium", amountUsd: 11.92, reasons: [] } });
    expect(subject).toBe(`Load ${LOAD} needs dispatch: no approval in two days`);
    const [first] = text.split("\n");
    expect(first).toContain("$11.92");
    expect(first).toContain("nothing was sent");
    expect(text).toContain("Arrived: 2026-10-20 11:28 EDT");
    expect(text).toContain("Driver's language: Spanish");
    expect(`${subject}\n${text}`).not.toMatch(/evidence confidence|Phase:|es_MX|T\d\d:\d\d:\d\d/);
  });

  it("names the reasons in words when a load needs a person", () => {
    const { subject, text } = escalationEmail(load, "sealed as NEEDS_HUMAN; review the pack before any claim", { pack: { confidence: "low", reasons: ["PIN_OUTSIDE_GEOFENCE"] } });
    expect(subject).toBe(`Load ${LOAD} needs dispatch: review before any claim`);
    expect(text.split("\n")[0]).toContain("a pin was outside the facility");
  });

  it("keeps every escalation subject short", () => {
    for (const reason of [
      "no approval within two days; nothing was sent",
      "approved, but the claims agent did not file the claim; send it by hand",
      "sealed as NEEDS_HUMAN; review the pack before any claim",
      "driver tapped Talk to dispatch",
      "release Flow rejected after the re-send limit",
      "some bill-of-lading pages could not be downloaded",
      "the detention notice email bounced; send notice another way",
      "RCS delivery failed (offer_release)",
      "WhatsApp delivery failed and RCS cannot reach this driver (release_flow)",
    ]) {
      expect(escalationEmail(load, reason).subject.length, reason).toBeLessThanOrEqual(70);
    }
  });

  it("puts the free-time end in the notice subject", () => {
    const { subject } = noticeEmail({ ...load, language: "en_US", released: null } as unknown as LoadItem, "2026-10-20T17:28:00.000Z");
    expect(subject).toBe(`Detention notice: Load ${LOAD} at Lakeshore DC, Columbus OH, free time ends 13:28 EDT`);
  });
});
