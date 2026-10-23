import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler, keyResultFields, summarizeStream } from "../src/invoke.js";

const agentcore = mockClient(BedrockAgentCoreClient);
const dynamo = mockClient(DynamoDBDocumentClient);

async function* events(list: unknown[]) {
  for (const e of list) yield e as never;
}

// A file_claim run as the harness streams it: evidence read, claim sent, final text.
const claimRun = [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Checking the evidence." } } },
  { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "t1", name: "dockclock___get_load_evidence" } } } },
  { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"loadId":"L1"}' } } } },
  { contentBlockStop: { contentBlockIndex: 1 } },
  { messageStop: { stopReason: "tool_use" } },
  { messageStart: { role: "user" } },
  { contentBlockStart: { contentBlockIndex: 0, start: { toolResult: { toolUseId: "t1", status: "success" } } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { toolResult: [{ text: JSON.stringify({ verdict: "BILLABLE", amountCents: 9099, packDigest: "d1", approval: { approvalId: "a" }, arrivedPin: "x", counterparty: { name: "N", email: "b@example.com" } }) }] } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStart: { role: "assistant" } },
  { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "t2", name: "dockclock___send_detention_claim" } } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"loadId":"L1","amountCents":9099,' } } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"approvalId":"a","recipientEmail":"b@example.com"}' } } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: "tool_use" } },
  { messageStart: { role: "user" } },
  { contentBlockStart: { contentBlockIndex: 0, start: { toolResult: { toolUseId: "t2", status: "success" } } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { toolResult: [{ json: { content: [{ text: '{"sent":true,"sesMessageId":"ses-1","recipientRole":"shipper"}' }] } }] } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Filed the claim for $90.99." } } },
  { messageStop: { stopReason: "end_turn" } },
];

describe("agent run record", () => {
  beforeEach(() => {
    agentcore.reset();
    dynamo.reset();
    dynamo.on(PutCommand).resolves({});
    Object.assign(process.env, { HARNESS_ARN: "arn:aws:bedrock-agentcore:us-east-1:111122223333:harness/h", TABLE_NAME: "loads", AGENT_MODEL_ID: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" });
  });

  it("keeps tool calls in order with their stripped inputs and key result fields", async () => {
    const out = await summarizeStream(events(claimRun));
    expect(out.recorded.map((c) => c.name)).toEqual(["dockclock___get_load_evidence", "dockclock___send_detention_claim"]);
    expect(out.recorded[0]!.result).toEqual({ verdict: "BILLABLE", amountCents: 9099, packDigest: "d1", approved: true });
    expect(out.recorded[1]!.input).toEqual({ loadId: "L1", amountCents: 9099, approvalId: "a" });
    expect(out.recorded[1]!.result).toEqual({ sent: true, sesMessageId: "ses-1", recipientRole: "shipper" });
    expect(out.finalText).toBe("Filed the claim for $90.99.");
    expect(out.stopReason).toBe("end_turn");
    expect(JSON.stringify(out.recorded)).not.toContain("example.com");
  });

  it("marks refusals and policy denials", () => {
    expect(keyResultFields('{"refused":"not approved by dispatch"}', "success")).toEqual({ refused: "not approved by dispatch" });
    expect(keyResultFields("Tool call was denied by the Cedar policy engine", "error")).toMatchObject({ policyDenied: true });
    expect(keyResultFields('{"error":{"code":-32002,"message":"Tool Execution Denied: Tool call not allowed due to policy enforcement"}}', "error")).toMatchObject({ policyDenied: true });
  });

  it("calls any other tool failure a plain tool error, not a Cedar denial", () => {
    for (const text of [
      "AccessDeniedException: User is not authorized to perform s3:GetObject",
      "Lambda function timed out",
      "ThrottlingException: Rate exceeded",
      "the claim was denied by the broker",
      "Forbidden",
    ]) {
      const out = keyResultFields(text, "error");
      expect(out.policyDenied, text).toBeUndefined();
    }
    // A refusal that happens to mention a policy stays a refusal.
    expect(keyResultFields('{"refused":"the Cedar policy needs an approval id"}', "error").policyDenied).toBeUndefined();
    // A successful result is never a denial.
    expect(keyResultFields("policy enforcement is on", "success").policyDenied).toBeUndefined();
    expect(keyResultFields('{"error":"bucket read failed: AccessDenied"}', "success")).toEqual({ error: "bucket read failed: AccessDenied" });
  });

  it("writes AGENT#<startedAt>#<task> into the load's partition", async () => {
    agentcore.on(InvokeHarnessCommand).resolves({ stream: events(claimRun) } as never);
    const run = await handler({ loadId: "L1", task: "file_claim" });
    expect(run.toolCalls).toHaveLength(2);
    const item = dynamo.commandCalls(PutCommand)[0]!.args[0].input.Item as Record<string, unknown>;
    expect(item.pk).toBe("LOAD#L1");
    expect(String(item.sk)).toMatch(/^AGENT#\d{4}-\d\d-\d\dT.+#file_claim$/);
    expect(item).toMatchObject({ kind: "agent_run", task: "file_claim", stopReason: "end_turn", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", finalText: "Filed the claim for $90.99." });
    expect(typeof item.durationMs).toBe("number");
  });

  it("records a failed run, then still fails", async () => {
    agentcore.on(InvokeHarnessCommand).rejects(new Error("throttled"));
    await expect(handler({ loadId: "L1", task: "review" })).rejects.toThrow("throttled");
    expect(dynamo.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ error: "throttled", task: "review" });
  });
});
