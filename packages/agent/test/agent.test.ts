import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { CEDAR_POLICIES, checkClaim, readBol, SYSTEM_PROMPT, TOOLS, type ClaimRequest, type SealedClaimBasis } from "../src/index.js";

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
const request: ClaimRequest = { loadId: "LIVE-abc", body, amountCents: 8000, packDigest: "d1", approvalId: "appr-1" };

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
    ["a whole letter instead of an opening", { body: `${body} ${"More detail. ".repeat(40)}` }, /opening must be 80-600 characters/],
    ["an opening too short to say what is claimed", { body: "LIVE-abc $80.00" }, /opening must be 80-600 characters/],
    ["an AWS resource name in the opening", { body: `${body} Key arn:aws:kms:us-east-1:111122223333:key/x.` }, /AWS resource name/],
    ["a phone number in the opening", { body: `${body} Call +14165550100.` }, /phone number/],
  ])("refuses %s", (_label, change, reason) => {
    const result = checkClaim({ ...request, ...change }, basis);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(reason);
  });

  it("files a load whose id holds a 12-digit run, and still refuses an account id beside it", () => {
    const id = "PO-123456789012";
    const named = body.replaceAll("LIVE-abc", id);
    const poBasis = { ...basis, loadId: id };
    expect(checkClaim({ ...request, loadId: id, body: named }, poBasis)).toEqual({ ok: true });
    const leaked = checkClaim({ ...request, loadId: id, body: `${named} Account 111122223333.` }, poBasis);
    expect(leaked.ok === false && leaked.reason).toMatch(/account id/);
  });

  it("refuses an account id or phone number that a short numeric load id would split", () => {
    // Fictional: a 555-01xx number and a made-up account id, each holding the load id.
    const id = "0143";
    const named = body.replaceAll("LIVE-abc", id);
    const shortBasis = { ...basis, loadId: id };
    expect(checkClaim({ ...request, loadId: id, body: named }, shortBasis)).toEqual({ ok: true });
    for (const leak of ["Account 999901439999.", "Call +14165550143.", "Key arn:aws:kms:x/0143."]) {
      const leaked = checkClaim({ ...request, loadId: id, body: `${named} ${leak}` }, shortBasis);
      expect(leaked.ok, leak).toBe(false);
    }
  });

  // Fictional numbers only: 555-01xx phone numbers and made-up account ids.
  it.each([
    "Call +1 416-555-0143.",
    "Call +1 (416) 555-0143.",
    "Call +1.416.555.0143.",
    "Call (416) 555-0143.",
    "Call (416)555-0143.",
    "Call 416-555-0143.",
    "Call 416.555.0143.",
    "Call 416 555 0143.",
    "Call 1-416-555-0143.",
    "Call 4165550143.",
    "Account 9999-0143-9999.",
    "Account 9999 0143 9999.",
    "Key ARN:aws:kms:us-east-1:x.",
    "Key Arn:Aws:kms:x.",
    "Key arn:aws-us-gov:kms:x.",
  ])("refuses a formatted leak: %s", (leak) => {
    const leaked = checkClaim({ ...request, body: `${body} ${leak}` }, basis);
    expect(leaked.ok === false && leaked.reason).toMatch(/AWS resource name, account id or phone number/);
  });

  it("files an opening with money, dates, times and durations", () => {
    const busy = "Detention claim for load LIVE-abc: arrived 2026-10-23 13:05 EDT (10/23/2026, 1:05 PM), released 14:30-14:35, 80 minutes past free time (+15 min grace). Amount owed: $80.00 of $1,234.56 billed.";
    expect(checkClaim({ ...request, body: busy }, basis)).toEqual({ ok: true });
  });

  // Every opening the leak check has misjudged, both ways, and the shapes around them. Fictional
  // numbers only: 555-01xx phone numbers and made-up account ids. A test name shows each separator
  // that is not a plain space by its code point.
  const shown = (text: string) => text.replace(/[^\x20-\x7e]/g, (c) => `<U+${c.codePointAt(0)!.toString(16).padStart(4, "0")}>`);
  it.each([
    ["files", "Grace (+15) 2026-10-23 13:05 EDT."],
    ["files", "Arrived 2026-10-23T13:05:00-04:00, released +2 hours past free time (+15 min grace)."],
    ["files", "Released 14:30–14:35 on 2026-10-23, 80 minutes past free time."],
    ["files", "Arrived at 13:05:00.123 EDT, released at 14:35:00.5 EDT."],
    // A freight reference short enough that it cannot be a phone number or an account id.
    ["files", "PRO 123456789 for load LIVE-abc."],
    ["files", "BOL #12345678, PO: 123456789, ref no. 1234567, order 12345, shipment number 123456789."],
    ["files", "Doors 12, 13 and 14, 3 trucks, 2 hours, $1,234.56 on 10/23/2026 at 1:05 PM."],
    ["refuses", "Accounts 111122223333,444455556666 billed."],
    ["refuses", "Account.111122223333 billed"],
    ["refuses", "Ref 1.111122223333"],
    ["refuses", "4165550143,4165550199"],
    ["refuses", "tel:416-555-0143"],
    ["refuses", "Phone:(416) 555-0143"],
    ["refuses", "Call 416-555-0143x12"],
    ["refuses", "Call 416 5550143."],
    ["refuses", "Account 1111.2222.3333."],
    ["refuses", "Call 416–555–0143."],
    ["refuses", "PRO 416 555 0143."],
    ["refuses", "Paid $4165550143."],
    ["refuses", "Grace +1 416-555-0143."],
    ["refuses", "Account 111122223333 on 2026-10-23 13:05."],
    ["refuses", "Key arn:aws:kms:us-east-1:x."],
    // Groups joined by more than one separator, or by any Unicode space, a tab or a line break.
    ["refuses", "Call +1 416 - 555 - 0143."],
    ["refuses", "+1 416  555  0143"],
    ["refuses", "416\t555\t0143"],
    ["refuses", "416\n555\n0143"],
    ["refuses", "+1\u2009416\u2009555\u20090143"],
    ["refuses", "416\u202f555\u202f0143"],
    ["refuses", "416\u00a0555\u00a00143"],
    ["refuses", "Account 1111\t2222\t3333"],
    ["refuses", "Call 416 — 555 — 0143."],
    ["refuses", "Call 416 / 555 / 0143."],
    ["refuses", "Call [416] 555 0143."],
    ["refuses", "Call ( 416 ) 555 . 0143."],
    ["refuses", "Call 416 ,555 ,0143."],
    ["refuses", "Call 416\u200b555\u200b0143."],
    ["refuses", "Call 416·555·0143."],
    ["refuses", "Call ４１６５５５０１４３."],
    // A labelled freight reference long enough to be a phone number or an account id.
    ["refuses", "PO 4165550143"],
    ["refuses", "shipment-4165550143"],
    ["refuses", "order 111122223333"],
    ["refuses", "Please reference order 111122223333"],
    ["refuses", "PRO 1234567890 for load LIVE-abc."],
    ["refuses", "BOL #123456789012"],
    ["refuses", "PO: 123456789012"],
    ["refuses", "ref no. 12345678901"],
    ["refuses", "shipment number 1234567890"],
    ["refuses", "Invoice 9876543210 covers 10/23/2026 at 1:05 PM, $1,234.56 in all."],
    ["refuses", "PO ABC-4165550143"],
    // Fractional seconds past three digits are not a clock time.
    ["refuses", "Arrived at 13:05:00.111122223333 EDT"],
    ["refuses", "Arrived at 13:05.4165550143 EDT"],
  ])("%s an opening with: %s", (outcome, text) => {
    const result = checkClaim({ ...request, body: `${body} ${text}` }, basis);
    if (outcome === "files") expect(result, shown(text)).toEqual({ ok: true });
    else expect(result.ok === false && result.reason, shown(text)).toMatch(/AWS resource name, account id or phone number/);
  });

  it("files the opening the live agent wrote for LIVE-mvpoqheg", () => {
    const opening = "We are claiming detention for load LIVE-mvpoqheg at Judge demo yard (any location counts) under the rate confirmation in the amount of $9.88.";
    const live = { ...basis, loadId: "LIVE-mvpoqheg", amountCents: 988 };
    expect(checkClaim({ ...request, loadId: "LIVE-mvpoqheg", amountCents: 988, body: opening }, live)).toEqual({ ok: true });
  });

  it("files a load whose id is shaped like a phone number, and still refuses a number beside it", () => {
    const id = "PO-416-555-0143";
    const named = body.replaceAll("LIVE-abc", id);
    const poBasis = { ...basis, loadId: id };
    expect(checkClaim({ ...request, loadId: id, body: named }, poBasis)).toEqual({ ok: true });
    expect(checkClaim({ ...request, loadId: id, body: `${named} Call (416) 555-0199.` }, poBasis).ok).toBe(false);
  });

  it("refuses unsealed, non-billable, unapproved or already-sent loads", () => {
    expect(checkClaim(request, { ...basis, phase: "documented" }).ok).toBe(false);
    expect(checkClaim(request, { ...basis, verdict: "NEEDS_HUMAN" }).ok).toBe(false);
    expect(checkClaim(request, { ...basis, approvalId: null }).ok).toBe(false);
    expect(checkClaim(request, { ...basis, alreadySentAt: "2026-10-18T12:00:00Z" }).ok).toBe(false);
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
    // The layout rule adds structure only: the money and date rules stay word for word.
    expect(SYSTEM_PROMPT).toContain("Never combine a local time with the date of a UTC timestamp.");
    expect(SYSTEM_PROMPT).toContain("You never change its verdict or amount");
    expect(SYSTEM_PROMPT).toContain("A claim above $5,000 is never filed by you");
    expect(SYSTEM_PROMPT).toContain("If the verdict is not BILLABLE or there is no dispatch approval, stop and say why.");
    expect(SYSTEM_PROMPT).toContain("If a tool refuses, report the refusal reason and stop. Do not retry with different numbers.");
    expect(SYSTEM_PROMPT).toContain("Quote times exactly as get_load_evidence gives them: the facility's local date, time and zone.");
    // The layout is the tool's template; the agent writes only the opening.
    expect(SYSTEM_PROMPT).toContain("You write only body, the opening: one or two formal, plain sentences (80 to 600 characters)");
    expect(TOOLS.find((t) => t.name === "send_detention_claim")!.inputSchema.required).toEqual(["loadId", "body", "amountCents", "packDigest", "approvalId"]);
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
