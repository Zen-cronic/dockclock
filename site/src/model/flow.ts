// The agent-workflow graph for one load, built only from its records: driver messages, the notice,
// the seal, every agent run (refusals included), the approval and the claim email.
import { approvalWords } from "../copy/provenance.js";
import type { LoadDetail } from "./model.js";

export interface FlowNode {
  id: string;
  at: string;
  title: string;
  services: string[];
  tone: "neutral" | "money" | "agent" | "ok" | "refused";
  icon: "chat" | "mail" | "lock" | "agent" | "check" | "stop";
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
  if (d.pack)
    nodes.push({ id: "seal", at: d.pack.sealedAt, title: `Sealed: ${d.verdict?.verdict === "BILLABLE" ? "owed" : (d.verdict?.verdict ?? "").toLowerCase().replace("_", " ")}`, services: ["Step Functions", "Lambda", "KMS", "S3 Object Lock"], tone: "money", icon: "lock", outcome: "signed", raw: { packId: d.pack.packId, digest: d.pack.digestSha256 } });
  for (const r of d.agentRuns)
    nodes.push({
      id: r.id,
      at: r.startedAt,
      title: r.filed ? "Agent filed the claim" : "Agent stopped",
      services: ["Bedrock AgentCore", "AgentCore Gateway", ...(r.filed ? ["SES"] : [])],
      tone: r.filed ? "agent" : "refused",
      icon: r.filed ? "agent" : "stop",
      outcome: r.filed ? (r.guard?.match ? "guard match" : "filed") : "no approval",
      raw: r,
    });
  const approvedAt = d.approval?.decidedAt ?? d.timeline.find((t) => /approv/i.test(t.title) && t.tone === "ok")?.at;
  if (approvedAt) nodes.push({ id: "approval", at: approvedAt, title: approvalWords(d).short.split(" ∙ ")[0] ?? "Approved", services: d.approval ? ["EUM Social", "Step Functions"] : ["DynamoDB"], tone: "ok", icon: "check", outcome: d.approval ? "one tap" : "test" });
  for (const e of d.emails.filter((x) => x.purpose === "claim"))
    nodes.push({ id: e.id, at: e.sentAt, title: "Claim emailed", services: ["SES"], tone: "ok", icon: "mail", outcome: e.deliveredAt ? "delivered" : "sent", raw: e });
  return nodes.sort((a, b) => a.at.localeCompare(b.at));
}
