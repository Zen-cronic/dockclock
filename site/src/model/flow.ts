// The agent-workflow graph for one load, built only from its records: driver messages, the notice,
// the seal, every agent run (refusals included), the approval and the claim email.
import { approvalWords, stoppedStep } from "../copy/provenance.js";
import type { LoadDetail } from "./model.js";

export interface FlowNode {
  id: string;
  at: string;
  title: string;
  services: string[];
  // "skipped": a step that never ran, drawn dashed.
  tone: "neutral" | "money" | "agent" | "ok" | "refused" | "skipped";
  icon: "chat" | "mail" | "lock" | "agent" | "check" | "stop" | "clock" | "doc";
  outcome?: string;
  raw?: unknown;
}

export function flowNodes(d: LoadDetail): FlowNode[] {
  const nodes: FlowNode[] = [];
  const driver = d.messages.filter((m) => m.party === "driver" && m.direction === "in");
  const first = driver[0];
  if (first) {
    const channels = [...new Set(driver.map((m) => m.channel))];
    nodes.push({
      id: "driver",
      at: first.at,
      title: `${driver.length} driver messages`,
      services: [...channels.map((c) => (c === "rcs" ? "EUM RCS" : "EUM Social")), "SNS", "SQS", "Lambda", "DynamoDB"],
      tone: "neutral",
      icon: "chat",
      outcome: driver.some((m) => m.synthetic) ? "replayed test" : "from phone",
    });
  }
  for (const e of d.emails.filter((x) => x.purpose === "notice"))
    nodes.push({ id: e.id, at: e.sentAt, title: "Detention notice emailed", services: ["EventBridge Scheduler", "Lambda", "SES"], tone: "money", icon: "mail", outcome: e.deliveredAt ? "delivered" : "sent", raw: e });
  const sealed = d.pack ? { at: d.pack.sealedAt, packId: d.pack.packId, digest: d.pack.digestSha256 } : d.packSummary ? { at: d.packSummary.sealedAt, packId: d.packSummary.packId, digest: d.packSummary.digestSha256 } : null;
  const noPaper = stoppedStep(d, "paperwork");
  if (noPaper && sealed)
    nodes.push({ id: "paperwork", at: new Date(Date.parse(sealed.at) - 1).toISOString(), title: "No bill-of-lading photo", services: noPaper.services, tone: "skipped", icon: "doc", outcome: "pins only", raw: noPaper });
  if (sealed)
    nodes.push({ id: "seal", at: sealed.at, title: `Sealed: ${d.verdict?.verdict === "BILLABLE" ? "owed" : (d.verdict?.verdict ?? "").toLowerCase().replace("_", " ")}`, services: ["Step Functions", "Lambda", "KMS", "S3 Object Lock"], tone: "money", icon: "lock", outcome: "signed", raw: { packId: sealed.packId, digest: sealed.digest } });
  if (d.approval?.requestedAt)
    nodes.push({ id: "asked", at: d.approval.requestedAt, title: "Approval asked of dispatch", services: ["Step Functions", "EUM Social"], tone: "neutral", icon: "chat", outcome: "sent" });
  for (const r of d.agentRuns)
    nodes.push({
      id: r.id,
      at: r.startedAt,
      title: r.filed ? "Agent filed the claim" : "Agent stopped",
      services: ["Bedrock AgentCore", "AgentCore Gateway", ...(r.filed ? ["SES"] : [])],
      tone: r.filed ? "agent" : "refused",
      icon: r.filed ? "agent" : "stop",
      outcome: r.filed ? (r.guard?.match ? "same amount" : "filed") : "no approval",
      raw: r,
    });
  const approvedAt = d.approval?.decidedAt ?? d.timeline.find((t) => /approv/i.test(t.title) && t.tone === "ok")?.at;
  if (approvedAt) nodes.push({ id: "approval", at: approvedAt, title: approvalWords(d).short.split(" ∙ ")[0] ?? "Approved", services: d.approval ? ["EUM Social", "Step Functions"] : ["DynamoDB"], tone: "ok", icon: "check", outcome: d.approval ? "one tap" : "test" });
  const noAnswer = stoppedStep(d, "approval");
  if (noAnswer) {
    const at = d.timeline.find((t) => t.tone === "refused" && /approv/i.test(t.title))?.at ?? d.approval?.requestedAt ?? sealed?.at ?? d.timeline.at(-1)?.at ?? "";
    nodes.push({ id: "no-answer", at, title: "No answer from dispatch", services: ["Lambda", "SES"], tone: "refused", icon: "clock", outcome: "timed out", raw: noAnswer });
    const noClaim = stoppedStep(d, "claim");
    if (noClaim && d.emails.every((x) => x.purpose !== "claim"))
      nodes.push({ id: "no-claim", at: new Date(Date.parse(at) + 1).toISOString(), title: "Claim not filed", services: noClaim.services, tone: "skipped", icon: "agent", outcome: "no approval", raw: noClaim });
  }
  for (const e of d.emails.filter((x) => x.purpose === "claim"))
    nodes.push({ id: e.id, at: e.sentAt, title: "Claim emailed", services: ["SES"], tone: "ok", icon: "mail", outcome: e.deliveredAt ? "delivered" : "sent", raw: e });
  return nodes.sort((a, b) => a.at.localeCompare(b.at));
}
