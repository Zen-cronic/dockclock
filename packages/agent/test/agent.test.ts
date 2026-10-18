import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { buildClaimMime, CEDAR_POLICIES, checkClaim, readBol, SYSTEM_PROMPT, TOOLS, type ClaimRequest, type SealedClaimBasis } from "../src/index.js";

const basis: SealedClaimBasis = {
  loadId: "LIVE-abc",
  phase: "sealed",
  verdict: "BILLABLE",
  amountCents: 8000,
  packDigest: "d1",
  packId: "LIVE-abc-1",
  approvalId: "appr-1",
  alreadySentAt: null,
};
const body = "Detention claim for load LIVE-abc at Lakeshore DC. The driver arrived on time and was released 80 minutes past free time. Amount owed: $80.00. Signed evidence attached.";
const request: ClaimRequest = { loadId: "LIVE-abc", subject: "Detention claim, load LIVE-abc", body, amountCents: 8000, packDigest: "d1", approvalId: "appr-1" };

describe("checkClaim: the agent words the claim, the sealed pack decides it", () => {
  it("accepts a claim that matches the sealed pack and the approval", () => {
    expect(checkClaim(request, basis)).toEqual({ ok: true });
  });

  it.each([
    ["a different amount", { amountCents: 9500 }, /differs from the contract amount 8000 cents/],
    ["a fractional amount", { amountCents: 8000.5 }, /differs/],
    ["a different digest", { packDigest: "x" }, /digest/],
    ["no approval", { approvalId: "other" }, /not approved/],
    ["an amount missing from the text", { body: body.replace("$80.00", "eighty dollars") }, /must state the contract amount/],
  ])("refuses %s", (_label, change, reason) => {
    const result = checkClaim({ ...request, ...change }, basis);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(reason);
  });

  it("refuses unsealed, non-billable, unapproved or already-sent loads", () => {
    expect(checkClaim(request, { ...basis, phase: "documented" }).ok).toBe(false);
    expect(checkClaim(request, { ...basis, verdict: "NEEDS_HUMAN" }).ok).toBe(false);
    expect(checkClaim(request, { ...basis, approvalId: null }).ok).toBe(false);
    expect(checkClaim(request, { ...basis, alreadySentAt: "2026-10-18T12:00:00Z" }).ok).toBe(false);
  });
});

describe("claim email", () => {
  it("carries the agent's text, the fixed verification footer and the signed pack as an attachment", () => {
    const mime = buildClaimMime({ from: "claims@example.com", to: "broker@example.com", subject: "Détention claim", body, packFileName: "p.json", packJson: '{"a":1}', footer: "Verify with KMS" }, "b1");
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="b1"');
    expect(mime).toContain('filename="p.json"');
    expect(mime).toMatch(/^Subject: =\?UTF-8\?B\?/m);
    const parts = mime.split("--b1");
    expect(Buffer.from(parts[1]!.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString()).toContain("Verify with KMS");
    expect(Buffer.from(parts[2]!.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString()).toBe('{"a":1}');
    expect(mime).not.toMatch(/^Reply-To:/m);
  });

  it("sends replies to the carrier's dispatch desk", () => {
    const mime = buildClaimMime({ from: "claims@example.com", to: "broker@example.com", replyTo: "dispatch@example.com", subject: "Claim", body, packFileName: "p.json", packJson: "{}", footer: "f" }, "b1");
    expect(mime).toMatch(/^Reply-To: dispatch@example\.com\r$/m);
  });
});

describe("tool contracts and policy", () => {
  it("names every tool the Cedar policies permit, and nothing else", () => {
    const policyText = Object.values(CEDAR_POLICIES).join("\n");
    for (const tool of TOOLS) expect(policyText).toContain(`dockclock-tools___${tool.name}`);
    expect(CEDAR_POLICIES.allow_approved_claims).toContain("context.input.amountCents <= 500000");
  });

  it("tells the agent it never sets the amount", () => {
    expect(SYSTEM_PROMPT).toContain("copy amountCents and packDigest exactly");
  });
});

describe("readBol", () => {
  it("returns typed fields from the forced tool call, and treats missing fields as unreadable", async () => {
    const bedrock = mockClient(BedrockRuntimeClient);
    bedrock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t", name: "record_bol_reading", input: { in_time: "1:52 PM", out_time: null, receiver_signed: true, legible: true, notes: "Out time not written." } } }] } },
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      metrics: { latencyMs: 1 },
    });
    const reading = await readBol(new Uint8Array([1, 2]), "image/jpeg", "model", new BedrockRuntimeClient({}));
    expect(reading).toEqual({ inTime: "1:52 PM", outTime: null, receiverSigned: true, legible: true, notes: "Out time not written." });
    const sent = bedrock.commandCalls(ConverseCommand)[0]!.args[0].input;
    expect(sent.toolConfig?.toolChoice).toEqual({ tool: { name: "record_bol_reading" } });
    expect(sent.inferenceConfig?.maxTokens).toBe(400);
    bedrock.restore();
  });
});
