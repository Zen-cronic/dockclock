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
      return "Test driver · real tap";
    default:
      return d.approval ? "Test driver" : "Test driver · test approval";
  }
}

export function provedWords(d: Pick<LoadDetail, "run" | "clock" | "verdict" | "summary">): Words {
  const channel = d.summary.channel === "rcs" ? "RCS" : "WhatsApp";
  const papersMatch = (d.verdict?.signals ?? []).filter((s) => s.name.startsWith("bol_") && s.name.includes("matches")).every((s) => s.ok);
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

export function approvalWords(d: Pick<LoadDetail, "approval" | "run" | "claim">): Words {
  const a = d.approval;
  const secs = d.claim?.secondsAfterApproval;
  const after = secs != null ? ` · emailed in ${Math.round(secs)} s` : "";
  if (a?.decision === "approve" && a.approver === "dispatcher")
    return { short: `Dispatcher tapped Approve${after}`, long: "The dispatcher tapped Approve on WhatsApp. Only the dispatcher, with that request's one-time code, can approve, and only once." };
  if (a?.decision === "approve" && a.approver === "demo_driver")
    return { short: `Approved on WhatsApp${after}`, long: "On a judge demo the driver is also the dispatcher and approves on WhatsApp." };
  if (a?.decision === "hold") return { short: "Held by dispatch", long: "Dispatch held the claim; nothing was sent." };
  const note = d.run.notes.find((n) => /approv/i.test(n));
  if (d.claim?.status === "sent") return { short: `Approved by a test command${after}`, long: note ?? "The approval was recorded by a test command, not on a phone." };
  return { short: "Awaiting approval", long: note ?? "No approval recorded yet." };
}

export function photoBadge(isFixture: boolean, realPhone: boolean): string {
  if (isFixture || !realPhone) return "Rendered test document";
  return "Fictional BOL, photographed on a real phone";
}
