// Copy follows provenance. Every claim the console makes about how a load was proved or approved
// comes from these functions, which read the records instead of assuming the happy path. The site
// tests render a test load through them and fail on "WhatsApp server times" or "tapped".
import { RELEASE_PIN_WINDOW_MINUTES, releasePinCheck, releasePinGapMinutes, releasePinGapWords, timeReadable } from "@dockclock/clause-engine";
import { clock } from "../format.js";
import { RUN_LABELS } from "../snapshot.js";
import type { LoadDetail } from "../model/model.js";

type Words = { short: string; long: string };

export function isRealPhoneRun(d: Pick<LoadDetail, "run" | "clock">): boolean {
  return (d.run.kind === "phone" || d.run.kind === "demo") && d.clock.driverTimes !== "synthetic_input";
}

// The judge-demo yard takes a pin from anywhere, so its pins prove server time, not place. Copy for
// those loads must never say a pin was checked against a yard.
export function acceptsAnyLocation(d: Pick<LoadDetail, "summary" | "snapshot">): boolean {
  return d.snapshot?.load.facility.id === "judge-demo" || /any location/i.test(d.summary.facility);
}

// A few words for a badge: what kind of run this was, in the words the Loads table and the API use.
export function runLabel(d: Pick<LoadDetail, "run">): string {
  return RUN_LABELS[d.run.kind];
}

export function provedWords(d: Pick<LoadDetail, "run" | "clock" | "verdict" | "summary">): Words {
  const channel = d.summary.channel === "rcs" ? "RCS" : "WhatsApp";
  // Only claim the papers match when a bill-of-lading check ran; with no photo there is none.
  const bolChecks = (d.verdict?.signals ?? []).filter((s) => s.name.startsWith("bol_") && s.name.includes("matches"));
  const papersMatch = bolChecks.length > 0 && bolChecks.every((s) => s.ok);
  if (!isRealPhoneRun(d))
    return {
      short: "Replayed test times",
      long: `The driver's taps and locations were replayed test messages with set times, run through the live ${channel} pipeline.${papersMatch ? " The bill-of-lading times match the locations." : ""}`,
    };
  return {
    short: `${channel} server times`,
    long: `Arrival and release locations carry ${channel}'s server timestamps.${papersMatch ? " The signed bill-of-lading times match them." : ""}`,
  };
}

// The landing's provenance line: what the recording is, and whose clock its times are. A real
// phone run (phone or demo, with recorded driver times) carries the channel's server times; any
// other load says its driver messages were synthetic.
export function recordingWords(d: Pick<LoadDetail, "run" | "clock" | "verdict" | "summary">): { source: string; times: string } {
  if (!isRealPhoneRun(d)) return { source: "Recorded from a test load with synthetic driver messages", times: "recorded times" };
  return {
    source: d.run.kind === "demo" ? "Recorded from a demo run on a real phone" : "Recorded from a real load on a real phone",
    times: provedWords(d).short,
  };
}

// What ended the stay on the landing: the Released tap on newer loads, the release pin on older ones.
export type ClockEndedBy = "released_tap" | "released_pin" | null;

// The landing's answer to "you weren't there that long": the two records that bound the stay, and
// whose times they carry.
export function stayProofWords(d: Pick<LoadDetail, "run" | "clock" | "summary">, endedBy: ClockEndedBy): string {
  const bounds = endedBy === "released_tap" ? "The arrival pin and the Released tap" : "Two location pins";
  if (!isRealPhoneRun(d)) return `${bounds}, replayed as test messages with set times.`;
  return `${bounds}, each with ${d.summary.channel === "rcs" ? "RCS" : "WhatsApp"}'s server time.`;
}

// Whose clock the dock clock runs on, in one sentence.
export function clockSourceWords(d: Pick<LoadDetail, "run" | "clock" | "summary">): string {
  if (!isRealPhoneRun(d)) return "The clock runs on the replayed test times.";
  return `The clock runs on ${d.summary.channel === "rcs" ? "RCS" : "WhatsApp"}'s own timestamps.`;
}

// The load's contract in one sentence: the demo clause or another, its free time, and its rate
// when the record has one. Null without a clause.
export function contractWords(d: Pick<LoadDetail, "clause">): string | null {
  const c = d.clause as LoadDetail["clause"] | null | undefined;
  if (!c) return null;
  const name = c.id === "judge-demo" ? "Demo contract" : "Contract";
  const free = Number.isFinite(c.freeTimeMinutes) ? `${c.freeTimeMinutes} minutes free` : null;
  const rate = Number.isFinite(c.ratePerHourUsd) ? `$${c.ratePerHourUsd} an hour` : null;
  const terms = [free, rate].filter(Boolean).join(", ");
  return terms ? `${name}: ${terms}.` : null;
}

// A workflow step that was skipped or failed, with the reason the workflow recorded.
export function stoppedStep(d: Pick<LoadDetail, "workflow">, key: string) {
  return d.workflow?.find((w) => w.key === key && (w.state === "failed" || w.state === "skipped")) ?? null;
}

export function approvalWords(d: Pick<LoadDetail, "approval" | "run" | "claim" | "workflow">): Words {
  const a = d.approval;
  const secs = d.claim?.secondsAfterApproval;
  const after = secs != null ? ` ∙ emailed in ${Math.round(secs)}\u00a0s` : "";
  if (a?.decision === "approve" && a.approver === "dispatcher")
    return { short: `Dispatcher tapped Approve${after}`, long: "The dispatcher tapped Approve on WhatsApp. Only the dispatcher, with that request's one-time code, can approve, and only once." };
  if (a?.decision === "approve" && a.approver === "demo_driver")
    return { short: `Approved on WhatsApp${after}`, long: "On a judge demo the driver is also the dispatcher and approves on WhatsApp." };
  if (a?.decision === "hold") return { short: "Held by dispatch", long: "Dispatch held the claim; nothing was sent." };
  const note = d.run.notes.find((n) => /approv/i.test(n));
  if (d.claim?.status === "sent") return { short: `Approved by a test command${after}`, long: note ?? "The approval was recorded by a test command, not on a phone." };
  const failed = stoppedStep(d, "approval");
  if (failed) return { short: "No answer from dispatch", long: "Nothing was filed." };
  if (a?.requestedAt && !a.decision) return { short: "Waiting for dispatch", long: "Approval was asked for; no answer yet." };
  return { short: "Awaiting approval", long: note ?? "No approval recorded yet." };
}

// One line for the test strip under the top bar, or null for a real run.
export function testStrip(d: Pick<LoadDetail, "run" | "clock" | "approval" | "claim">): string | null {
  if (isRealPhoneRun(d)) return null;
  const approval = d.approval ? "" : d.claim?.status === "sent" ? " ∙ test approval" : "";
  return `Test load ∙ replayed driver${approval} ∙ AWS live`;
}

export function photoBadge(isFixture: boolean, realPhone: boolean): string {
  if (isFixture || !realPhone) return "Rendered test document";
  return "Fictional BOL, photographed on a real phone";
}

// The release in one line. With a Released tap the clock stopped at the tap and the pin confirms
// it, unless the pin came outside the window (RELEASE_PIN_LATE) or a time could not be read
// (TIMESTAMP_UNREADABLE): then a person reviews the load. An older load's release is the pin
// alone. A closed load never released says so.
export function releaseLine(c: Pick<LoadDetail["clock"], "releasedAt" | "releasePinAt" | "endedAt">, timeZone: string): string | null {
  if (c.releasedAt && c.releasePinAt) {
    const stopped = timeReadable(c.releasedAt) ? `Clock stopped at the Released tap ${clock(c.releasedAt, timeZone)}` : "The Released tap's time could not be read";
    const check = releasePinCheck(c.releasedAt, c.releasePinAt);
    if (check === "unreadable") return `${stopped}${timeReadable(c.releasePinAt) ? "" : "; the pin's time could not be read"}, so a person reviews the load`;
    if (check === "confirmed") return `${stopped}; pin confirmed ${clock(c.releasePinAt, timeZone)}`;
    const early = releasePinGapMinutes(c.releasedAt, c.releasePinAt) < 0;
    const gap = releasePinGapWords(c.releasedAt, c.releasePinAt);
    return `${stopped}; pin ${early ? "early" : "late"} at ${clock(c.releasePinAt, timeZone)} (${gap} the tap, limit ${RELEASE_PIN_WINDOW_MINUTES}), so a person reviews the load`;
  }
  if (c.releasedAt) return null;
  // A close time that does not parse says nothing here; the band's unreadable note speaks for it.
  if (c.endedAt) return timeReadable(c.endedAt) ? `Clock stopped at ${clock(c.endedAt, timeZone)}: the load ended without a release` : null;
  return null;
}
