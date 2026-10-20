import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

export type AgentTask = "review" | "file_claim";

export interface AgentRun {
  loadId: string;
  task: AgentTask;
  text: string;
  stopReason: string | null;
  toolCalls: Array<{ name: string; input: string }>;
}

// One tool call as recorded: its name, its input with anything sensitive removed, and the key
// fields of its result (refusals, the SES message id, a policy denial), never the whole result.
export interface RecordedToolCall {
  name: string;
  input: Record<string, unknown> | string;
  status: string | null;
  result: Record<string, unknown>;
}

export interface AgentRunRecord {
  pk: string;
  sk: string;
  kind: "agent_run";
  loadId: string;
  task: AgentTask;
  startedAt: string;
  durationMs: number;
  modelId: string | null;
  stopReason: string | null;
  toolCalls: RecordedToolCall[];
  finalText: string;
  error?: string;
}

const client = new BedrockAgentCoreClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

// The only text the agent ever receives from outside is this fixed task line plus a validated
// load id, so no driver or broker content can steer it from here.
export function taskPrompt(loadId: string, task: AgentTask): string {
  if (!/^[A-Za-z0-9-]{1,40}$/.test(loadId)) throw new Error("invalid load id");
  return task === "review"
    ? `Review load ${loadId}: check its evidence and read the bill-of-lading photo. Report legibility and whether the photo's times agree with the pins and the driver's entries.`
    : `File the detention claim for load ${loadId} if, and only if, its sealed verdict is BILLABLE and dispatch approved it.`;
}

const SENSITIVE_KEY = /phone|e164|bsuid|email|address|recipient(?!Role)|token|arn|secret|^lat$|^lon$|latitude|longitude|s3key/i;

// Drops keys that could carry a person's contact, a location or an AWS resource name.
export function stripSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SENSITIVE_KEY.test(k))
        .map(([k, v]) => [k, stripSensitive(v)]),
    );
  }
  return value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Gateway results arrive as MCP content: often a text block holding the Lambda's JSON.
function unwrap(value: unknown): unknown {
  if (typeof value === "string") {
    const parsed = parseJson(value);
    return parsed === undefined || typeof parsed !== "object" ? value : unwrap(parsed);
  }
  const content = (value as { content?: Array<{ text?: string }> } | null)?.content;
  if (Array.isArray(content) && content.length > 0 && typeof content[0]?.text === "string") return unwrap(content.map((c) => c.text ?? "").join(""));
  return value;
}

const POLICY_DENIAL = /cedar|policy|not authori[sz]ed|access ?denied|forbidden|denied/i;
const RESULT_FIELDS = ["refused", "error", "sent", "sentAt", "sesMessageId", "recipientRole", "amountUsd", "amountCents", "verdict", "reasons", "phase", "packDigest", "confidence", "claimSentAt"];

// The fields of a tool result a reviewer needs: why it refused, what it sent, what the policy said.
export function keyResultFields(raw: string, status: string | null): Record<string, unknown> {
  const value = unwrap(raw);
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    for (const k of RESULT_FIELDS) if (v[k] !== undefined && v[k] !== null) out[k] = v[k];
    if ("approval" in v) out.approved = v.approval !== null && v.approval !== undefined;
    const reading = (v.reading ?? v.photoReading) as Record<string, unknown> | null | undefined;
    if (reading && typeof reading === "object") {
      out.reading = Object.fromEntries(["legible", "inTime", "outTime", "receiverSigned", "model"].filter((k) => reading[k] !== undefined).map((k) => [k, reading[k]]));
    }
    if (v.comparedWithPins) out.comparedWithPins = v.comparedWithPins;
  } else if (typeof value === "string" && value) {
    out.text = value.slice(0, 400);
  }
  const errorText = typeof out.error === "string" ? out.error : typeof out.text === "string" ? out.text : "";
  if ((status === "error" || errorText) && POLICY_DENIAL.test(errorText)) out.policyDenied = true;
  return stripSensitive(out) as Record<string, unknown>;
}

type StreamEvent = {
  messageStart?: { role?: string };
  contentBlockStart?: { contentBlockIndex?: number; start?: { toolUse?: { toolUseId?: string; name?: string }; toolResult?: { toolUseId?: string; status?: string } } };
  contentBlockDelta?: { contentBlockIndex?: number; delta?: { text?: string; toolUse?: { input?: string }; toolResult?: Array<{ text?: string; json?: unknown }> } };
  contentBlockStop?: { contentBlockIndex?: number };
  messageStop?: { stopReason?: string };
  validationException?: { message?: string };
  internalServerException?: { message?: string };
  runtimeClientError?: { message?: string };
};

export interface StreamSummary {
  text: string;
  finalText: string;
  stopReason: string | null;
  toolCalls: AgentRun["toolCalls"];
  recorded: RecordedToolCall[];
}

type Block = { kind: "use"; id: string; name: string; input: string } | { kind: "result"; id: string; status: string | null; body: string };

// Reads the harness stream in order: tool calls with their inputs, tool results matched to their
// calls by toolUseId, the assistant's text per message, and the stop reason.
export async function summarizeStream(stream: AsyncIterable<StreamEvent>): Promise<StreamSummary> {
  let text = "";
  let messageText = "";
  let finalText = "";
  let stopReason: string | null = null;
  const toolCalls: AgentRun["toolCalls"] = [];
  const recorded: RecordedToolCall[] = [];
  const byUseId = new Map<string, RecordedToolCall>();
  const blocks = new Map<number, Block>();
  for await (const event of stream) {
    if (event.messageStart) messageText = "";
    const start = event.contentBlockStart;
    if (start) {
      const index = start.contentBlockIndex ?? 0;
      const use = start.start?.toolUse;
      const result = start.start?.toolResult;
      if (use?.name) blocks.set(index, { kind: "use", id: use.toolUseId ?? `use-${recorded.length}`, name: use.name, input: "" });
      else if (result) blocks.set(index, { kind: "result", id: result.toolUseId ?? "", status: result.status ?? null, body: "" });
    }
    const delta = event.contentBlockDelta;
    if (delta?.delta) {
      const block = blocks.get(delta.contentBlockIndex ?? 0);
      if (delta.delta.text) {
        text += delta.delta.text;
        messageText += delta.delta.text;
      }
      if (delta.delta.toolUse && block?.kind === "use") block.input += delta.delta.toolUse.input ?? "";
      if (delta.delta.toolResult && block?.kind === "result") {
        for (const part of delta.delta.toolResult) block.body += part.text ?? (part.json !== undefined ? JSON.stringify(part.json) : "");
      }
    }
    if (event.contentBlockStop) {
      const index = event.contentBlockStop.contentBlockIndex ?? 0;
      const block = blocks.get(index);
      if (block?.kind === "use") {
        toolCalls.push({ name: block.name, input: block.input });
        const parsed = parseJson(block.input);
        const input = parsed && typeof parsed === "object" ? (stripSensitive(parsed) as Record<string, unknown>) : block.input.slice(0, 400);
        const call: RecordedToolCall = { name: block.name, input, status: null, result: {} };
        recorded.push(call);
        byUseId.set(block.id, call);
      } else if (block?.kind === "result") {
        const call = byUseId.get(block.id) ?? recorded[recorded.length - 1];
        if (call) {
          call.status = block.status;
          call.result = keyResultFields(block.body, block.status);
        }
      }
      blocks.delete(index);
    }
    if (event.messageStop) {
      if (event.messageStop.stopReason) stopReason = event.messageStop.stopReason;
      if (messageText.trim()) finalText = messageText.trim();
    }
    const failure = event.validationException ?? event.internalServerException ?? event.runtimeClientError;
    if (failure) throw new Error(`agent stream error: ${failure.message ?? "unknown"}`);
  }
  if (messageText.trim()) finalText = messageText.trim();
  return { text: text.trim(), finalText, stopReason, toolCalls, recorded };
}

export function agentRunRecord(input: Omit<AgentRunRecord, "pk" | "sk" | "kind">): AgentRunRecord {
  return { pk: `LOAD#${input.loadId}`, sk: `AGENT#${input.startedAt}#${input.task}`, kind: "agent_run", ...input };
}

// The run is evidence, not control state: a failure to record it is logged and never fails the run.
async function saveRun(record: AgentRunRecord): Promise<void> {
  const table = process.env.TABLE_NAME;
  if (!table) return;
  try {
    await ddb.send(new PutCommand({ TableName: table, Item: record }));
  } catch (error) {
    console.log(JSON.stringify({ kind: "agent_run_unrecorded", loadId: record.loadId, task: record.task, error: (error as Error).name }));
  }
}

// Called by Step Functions ("Agent files the claim") and by npm run agent:run alike, so every run
// is recorded under the load as AGENT#<startedAt>#<task>.
export async function handler(input: { loadId: string; task: AgentTask }): Promise<AgentRun> {
  const harnessArn = process.env.HARNESS_ARN;
  if (!harnessArn) throw new Error("missing env HARNESS_ARN");
  const prompt = taskPrompt(input.loadId, input.task);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const modelId = process.env.AGENT_MODEL_ID ?? null;
  const base = { loadId: input.loadId, task: input.task, startedAt, modelId };
  let summary: StreamSummary;
  try {
    const out = await client.send(
      new InvokeHarnessCommand({
        harnessArn,
        runtimeSessionId: `${input.loadId}-${input.task}-${randomUUID()}`,
        messages: [{ role: "user", content: [{ text: prompt }] }],
      }),
    );
    summary = await summarizeStream((out.stream ?? []) as AsyncIterable<StreamEvent>);
  } catch (error) {
    await saveRun(agentRunRecord({ ...base, durationMs: Date.now() - started, stopReason: null, toolCalls: [], finalText: "", error: (error as Error).message.slice(0, 400) }));
    throw error;
  }
  await saveRun(agentRunRecord({ ...base, durationMs: Date.now() - started, stopReason: summary.stopReason, toolCalls: summary.recorded, finalText: summary.finalText }));
  console.log(JSON.stringify({ kind: "agent_run", loadId: input.loadId, task: input.task, stopReason: summary.stopReason, tools: summary.toolCalls.map((c) => c.name) }));
  return { loadId: input.loadId, task: input.task, text: summary.text, stopReason: summary.stopReason, toolCalls: summary.toolCalls };
}
