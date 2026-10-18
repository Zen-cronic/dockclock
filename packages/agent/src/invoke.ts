import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";

export type AgentTask = "review" | "file_claim";

export interface AgentRun {
  loadId: string;
  task: AgentTask;
  text: string;
  stopReason: string | null;
  toolCalls: Array<{ name: string; input: string }>;
}

const client = new BedrockAgentCoreClient({});

// The only text the agent ever receives from outside is this fixed task line plus a validated
// load id, so no driver or broker content can steer it from here.
export function taskPrompt(loadId: string, task: AgentTask): string {
  if (!/^[A-Za-z0-9-]{1,40}$/.test(loadId)) throw new Error("invalid load id");
  return task === "review"
    ? `Review load ${loadId}: check its evidence and read the bill-of-lading photo. Report legibility and whether the photo's times agree with the pins and the driver's entries.`
    : `File the detention claim for load ${loadId} if, and only if, its sealed verdict is BILLABLE and dispatch approved it.`;
}

export async function handler(input: { loadId: string; task: AgentTask }): Promise<AgentRun> {
  const harnessArn = process.env.HARNESS_ARN;
  if (!harnessArn) throw new Error("missing env HARNESS_ARN");
  const out = await client.send(
    new InvokeHarnessCommand({
      harnessArn,
      runtimeSessionId: `${input.loadId}-${input.task}-${randomUUID()}`,
      messages: [{ role: "user", content: [{ text: taskPrompt(input.loadId, input.task) }] }],
    }),
  );
  let text = "";
  let stopReason: string | null = null;
  const toolCalls: AgentRun["toolCalls"] = [];
  const pending = new Map<number, { name: string; input: string }>();
  for await (const event of out.stream ?? []) {
    const start = event.contentBlockStart;
    const startTool = (start?.start as { toolUse?: { name?: string } } | undefined)?.toolUse;
    if (start && startTool?.name) pending.set(start.contentBlockIndex ?? 0, { name: startTool.name, input: "" });
    const delta = event.contentBlockDelta;
    if (delta?.delta && "text" in delta.delta && delta.delta.text) text += delta.delta.text;
    if (delta?.delta && "toolUse" in delta.delta && delta.delta.toolUse) {
      const call = pending.get(delta.contentBlockIndex ?? 0);
      if (call) call.input += delta.delta.toolUse.input ?? "";
    }
    if (event.contentBlockStop) {
      const call = pending.get(event.contentBlockStop.contentBlockIndex ?? 0);
      if (call) toolCalls.push(call);
      pending.delete(event.contentBlockStop.contentBlockIndex ?? 0);
    }
    if (event.messageStop?.stopReason) stopReason = event.messageStop.stopReason;
    const failure = event.validationException ?? event.internalServerException ?? event.runtimeClientError;
    if (failure) throw new Error(`agent stream error: ${failure.message ?? "unknown"}`);
  }
  console.log(JSON.stringify({ kind: "agent_run", loadId: input.loadId, task: input.task, stopReason, tools: toolCalls.map((c) => c.name) }));
  return { loadId: input.loadId, task: input.task, text: text.trim(), stopReason, toolCalls };
}
