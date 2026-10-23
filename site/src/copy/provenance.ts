// Copy follows provenance. Every claim the console makes about how a load was proved or approved
// comes from these functions, which read the records instead of assuming the happy path. The site
// tests render a test load through them and fail on "WhatsApp server times" or "tapped".
import type { LoadDetail } from "../model/model.js";

type Words = { short: string; long: string };

export function isRealPhoneRun(d: Pick<LoadDetail, "run" | "clock">): boolean {
  return (d.run.kind === "phone" || d.run.kind === "demo") && d.clock.driverTimes !== "synthetic_input";
}

// A few words for a badge: what kind of run this was.
export function runLabel(d: Pick<LoadDetail, "run" | "approval">): string {
  switch (d.run.kind) {
    case "phone":
      return "Real phone";
    case "demo":
      return "Judge demo";
    case "operator":
      return "Test load ∙ real tap";
    default:
      return "Test load";
  }
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

// A workflow step that was skipped or failed, with the reason the workflow recorded.
export function stoppedStep(d: Pick<LoadDetail, "workflow">, key: string) {
  return d.workflow?.find((w) => w.key === key && (w.state === "failed" || w.state === "skipped")) ?? null;
}

export function approvalWords(d: Pick<LoadDetail, "approval" | "run" | "claim" | "workflow">): Words {
  const a = d.approval;
  const secs = d.claim?.secondsAfterApproval;
  const after = secs != null ? ` ∙ emailed in ${Math.round(secs)} s` : "";
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
