import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clauseById, evaluate } from "@dockclock/clause-engine";
import { buildPack, corroborate, facilityById, LocalSigner, sealPack, toLoadEvidence, type LoadRecord } from "@dockclock/evidence";
import { describe, expect, it } from "vitest";
import { buildMime } from "@dockclock/mail";
import { renderWhatsApp } from "../services/src/outbound.js";
import { dispatchTemplate } from "../services/src/sender.js";
import { findLeaks } from "@dockclock/sanitize";
import { buildSnapshot } from "../scripts/desk/build-snapshot.js";
import { DEMO_TEXT_BODY } from "../services/api/describe.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const ACCOUNT = "925432502717";
const PHONE = "+15550100001";
const BSUID = "US.13491208655302741918";
const ARN = `arn:aws:kms:us-east-1:${ACCOUNT}:key/9006e29c-0565-4b1a-abc9-91ca901a923c`;
const facility = facilityById("lakeshore-columbus");
const INSIDE: [number, number] = [-82.938, 39.8995];
// A wamid built like a real one: base64 of a structure holding the sender's number.
const wamid = (n: number) => `wamid.${Buffer.from(`\u0018\u000b15550100001\u0015\u0002${n}ABCDEF0123456789`).toString("base64")}`;
const T = (h: number, m: number) => `2026-10-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

async function sources() {
  const record: LoadRecord = {
    loadId: "LIVE-test1",
    clauseId: "lakeshore-foods",
    facility,
    appointmentAt: T(14, 0),
    arrived: { kind: "arrived", channel: "whatsapp", messageId: wamid(2), serverAt: T(13, 50), location: INSIDE },
    released: { kind: "released", channel: "whatsapp", messageId: wamid(6), serverAt: T(17, 20), location: INSIDE },
    bol: { channel: "whatsapp", messageId: wamid(7), serverAt: T(17, 25), cameraOnly: true, pageSha256s: ["ab".repeat(32)], timesEdited: { in: true, out: true }, signed: true, checkIn: T(13, 52), checkOut: T(17, 18), confirmedByDriver: true },
    status214: false,
    notice: null,
    shipperConfirmation: null,
  };
  const sealedAt = T(17, 30);
  const evaluation = evaluate(toLoadEvidence(record, sealedAt), clauseById("lakeshore-foods"));
  const pack = buildPack(record, corroborate(record), evaluation, sealedAt);
  const signedPack = { ...(await sealPack(pack, new LocalSigner())), keyId: ARN };
  const pin = (n: number, at: string) => ({ channel: "whatsapp", messageId: wamid(n), serverAt: at, lat: INSIDE[1], lon: INSIDE[0] });
  const ev = (n: number, at: string, type: string, outcome: string, detail: Record<string, unknown>) => ({
    pk: "LOAD#LIVE-test1",
    sk: `EVENT#${at}#${wamid(n)}`,
    messageId: wamid(n),
    serverAt: at,
    type,
    outcome,
    channel: "whatsapp",
    phaseBefore: "x",
    phaseAfter: "y",
    detail,
  });
  const items = [
    {
      pk: "LOAD#LIVE-test1",
      sk: "META",
      loadId: "LIVE-test1",
      clauseId: "lakeshore-foods",
      facilityId: "lakeshore-columbus",
      appointmentAt: T(14, 0),
      address: { kind: "phone", e164: PHONE },
      driverKey: "phone:abc",
      boundBsuid: BSUID,
      executionArn: `arn:aws:states:us-east-1:${ACCOUNT}:execution:dockclock-load-lifecycle:LIVE-test1-1`,
      tokens: { arrived: "secret-token" },
      nonce: "68220ac1613f",
      language: "en_US",
      channel: "whatsapp",
      phase: "sealed",
      arrived: pin(2, T(13, 50)),
      released: pin(6, T(17, 20)),
      bol: { channel: "whatsapp", messageId: wamid(7), serverAt: T(17, 25), inTime: "09:52", outTime: "13:18", receiverSigned: true, delayReason: null, photos: [{ mediaId: "m1", mimeType: "image/jpeg", s3Key: "bol/LIVE-test1/p1.jpg", sha256: "ab".repeat(32) }] },
      notice: { scheduledFor: T(15, 20), sentAt: T(15, 20), messageId: "0100-ses-notice", deliveredAt: T(15, 21), mimeKey: "packs/LIVE-test1/notice.eml" },
      sealedPackId: pack.packId,
      bolReading: { legible: true, inTime: "09:52", outTime: "13:18", receiverSigned: true, model: "us.amazon.nova-pro-v1:0", readAt: T(17, 29), page: 1 },
    },
    ev(1, T(13, 49), "button", "ADVANCED", { payload: "dc1.arrived.LIVE-test1.68220ac1613f" }),
    ev(2, T(13, 50), "location", "ADVANCED", { lat: INSIDE[1], lon: INSIDE[0] }),
    ev(3, T(16, 0), "text", "IGNORED", { text: `call me at ${PHONE}` }),
    ev(5, T(17, 19), "button", "ADVANCED", { payload: "dc1.released.LIVE-test1.68220ac1613f" }),
    ev(6, T(17, 20), "location", "ADVANCED", { lat: INSIDE[1], lon: INSIDE[0] }),
    ev(7, T(17, 25), "flow", "ADVANCED", { flowToken: "dc1.release.LIVE-test1.68220ac1613f" }),
    { pk: "LOAD#LIVE-test1", sk: `SEND#${T(13, 0)}#out-1`, kind: "send", messageId: "out-1", channel: "whatsapp", purpose: "dispatch_template", audience: "driver", sentAt: T(13, 0), message: renderWhatsApp(dispatchTemplate("en_US", "LIVE-test1", "n1", facility.name, "Oct 13, 10:00 AM")) },
    { pk: "LOAD#LIVE-test1", sk: `PACK#${pack.packId}`, s3Key: `packs/LIVE-test1/${pack.packId}.json`, keyId: ARN, digest: "d", verdict: evaluation.verdict, confidence: "high" },
    { pk: "LOAD#LIVE-test1", sk: "APPROVAL_REQUEST", token: "task-token-secret", nonce: "n2", requestedAt: T(17, 31), decidedAt: T(17, 32), decision: "approve" },
    { pk: "LOAD#LIVE-test1", sk: "APPROVAL", approvalId: "appr-1", approvedAt: T(17, 32), approver: "dispatcher-whatsapp", approvalMessageId: wamid(9) },
    {
      pk: "LOAD#LIVE-test1",
      sk: `AGENT#${T(17, 32)}#file_claim`,
      kind: "agent_run",
      task: "file_claim",
      startedAt: T(17, 32),
      durationMs: 14000,
      modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      stopReason: "end_turn",
      finalText: "Filed.",
      toolCalls: [
        { name: "dockclock-tools___get_load_evidence", input: { loadId: "LIVE-test1" }, status: "success", result: { verdict: "BILLABLE", amountUsd: evaluation.amountUsd, approved: true } },
        { name: "dockclock-tools___send_detention_claim", input: { loadId: "LIVE-test1", amountCents: Math.round(evaluation.amountUsd * 100), packDigest: "will-not-match", approvalId: "appr-1", body: "x".repeat(300) }, status: "success", result: { sent: true, sesMessageId: "0100-ses-claim" } },
      ],
    },
    { pk: "LOAD#LIVE-test1", sk: "CLAIM", status: "sent", amountUsd: evaluation.amountUsd, amountCents: Math.round(evaluation.amountUsd * 100), packDigest: "d", sentAt: T(17, 32), subject: "Detention claim", mimeKey: "packs/LIVE-test1/claim.eml" },
  ];
  // A claim in the older layout, whose footer named the KMS key: the export must remove it.
  const claim = buildMime({
    from: "DockClock Claims <claims@example.com>",
    to: "broker+dc-shipper@example.com",
    subject: "Detention claim – LIVE-test1",
    date: new Date(T(17, 32)),
    text: `Body of the claim.\n\nSigned with AWS KMS key ${ARN}.`,
    html: `<p>Body of the claim.</p><p>Signed with AWS KMS key ${ARN}.</p>`,
    attachments: [{ filename: `${pack.packId}.json`, contentType: "application/json", content: JSON.stringify(signedPack) }],
  });
  const notice = buildMime({ from: "claims@example.com", to: "broker+dc-shipper@example.com", subject: "Detention notice: load LIVE-test1", text: "Notice text.", html: "<p>Notice text.</p>", date: new Date(T(15, 20)) });
  return { items, receipts: { "out-1": { deliveredAt: T(13, 1), readAt: T(13, 2) } }, signedPack, emails: { notice, claim }, spkiSha256: "spki", exportedAt: T(18, 0) };
}

describe("desk snapshot", () => {
  it("publishes no coordinates, phone numbers, BSUIDs, ARNs, account id, S3 keys or message ids", async () => {
    const src = await sources();
    // The inputs really do hold all of them.
    expect(findLeaks(src.items, ACCOUNT).length).toBeGreaterThan(5);
    const snapshot = buildSnapshot(src);
    expect(findLeaks(snapshot, ACCOUNT)).toEqual([]);
    const text = JSON.stringify(snapshot);
    expect(text).not.toMatch(/"(lat|lon|latitude|longitude)"/);
    expect(text).not.toMatch(/\[\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*\]/);
    expect(text).not.toContain(String(INSIDE[0]));
    expect(text).not.toContain(String(INSIDE[1]));
    expect(text).not.toMatch(/\+\d{10,15}/);
    expect(text).not.toContain(BSUID);
    expect(text).not.toContain("arn:aws");
    expect(text).not.toContain(ACCOUNT);
    expect(text).not.toMatch(/packs\/|bol\/LIVE|s3:\/\//);
    expect(text).not.toContain("wamid.");
    expect(text).not.toContain("68220ac1613f");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("modelledOn");
    expect(text).not.toContain("Campbell");
  });

  it("maps the records the desk needs", async () => {
    const snapshot = buildSnapshot(await sources());
    expect(snapshot.run.kind).toBe("phone");
    expect(snapshot.messages.map((m) => m.id)).toEqual(snapshot.messages.map((_, i) => `m${i + 1}`));
    const dispatch = snapshot.messages[0]!;
    expect(dispatch).toMatchObject({ direction: "out", templateName: "dockclock_load_dispatch", status: "read", bodyProvenance: "recorded" });
    expect(dispatch.body).toContain("Load LIVE-test1 is booked");
    expect(snapshot.messages.find((m) => m.kind === "location")?.location).toEqual({ insideGeofence: true, note: "Inside the facility area. Coordinates are not shown." });
    expect(snapshot.messages.find((m) => m.kind === "text")?.body).toBe("call me at <phone removed>");
    expect(snapshot.emails.map((e) => e.purpose)).toEqual(["notice", "claim"]);
    expect(snapshot.emails[1]!.attachments[0]!.name).toBe(`${snapshot.pack.packId}.json`);
    expect(snapshot.emails[1]!.body).toContain("<AWS resource name removed>");
    expect(snapshot.agentRuns[0]!.toolCalls.map((c) => c.name)).toEqual(["get_load_evidence", "send_detention_claim"]);
    expect(snapshot.agentRuns[0]!.guard?.match).toBe(false);
    expect(snapshot.agentRuns[0]!.toolCalls[1]!.input.body).toBe("(the email body, shown in the mailbox)");
    expect(snapshot.approval).toMatchObject({ decision: "approve", approver: "dispatcher" });
    expect(snapshot.clause.basis).toMatch(/^Modelled on published shipper terms/);
    // The engine inputs reproduce the sealed verdict.
    const again = evaluate({ loadId: "LIVE-test1", clauseId: "lakeshore-foods", facility: facility.name, ...snapshot.verdict.engineInput }, clauseById("lakeshore-foods"));
    expect(again.amountUsd).toBe(snapshot.verdict.amountUsd);
    expect(snapshot.pack.pack).toEqual((await sources()).signedPack.pack);
  });

  // The same rule as the read API (services/api/view.ts): a DEMO sender's typed words never leave the load.
  it("keeps a DEMO sender's typed text out of the replay file, even in the raw record", async () => {
    const src = await sources();
    const meta = src.items.find((i) => i.sk === "META")!;
    Object.assign(meta, { demo: true, ws: "demo" });
    const words = "my private words to dispatch";
    const text = src.items.find((i) => (i as { type?: string }).type === "text") as unknown as { detail: { text: string } };
    text.detail.text = words;
    const snapshot = buildSnapshot(src);
    expect(snapshot.run.kind).toBe("demo");
    expect(snapshot.messages.find((m) => m.kind === "text")?.body).toBe(DEMO_TEXT_BODY);
    expect(JSON.stringify(snapshot)).not.toContain(words);
    // A carrier load still shows the (scrubbed) text.
    expect(buildSnapshot(await sources()).messages.find((m) => m.kind === "text")?.body).toBe("call me at <phone removed>");
  });

  it("shows a send the gate blocked as composed, not sent, with no receipts", async () => {
    const src = await sources();
    src.items.push({ pk: "LOAD#LIVE-test1", sk: `SEND#${T(13, 1)}#blocked-1`, kind: "send", messageId: "blocked-1", channel: "whatsapp", purpose: "location_request", audience: "driver", sentAt: T(13, 1), message: { kind: "location_request", text: "Share your location" }, status: "not_sent", notSentReason: `Not sent: ${PHONE} is a test number.` } as never);
    src.receipts["blocked-1"] = { pk: "MSG#blocked-1", sk: "RECEIPT", deliveredAt: T(13, 2) } as never;
    const snapshot = buildSnapshot(src);
    const blocked = snapshot.messages.find((m) => m.at === T(13, 1))!;
    expect(blocked).toMatchObject({ status: "not_sent", receipts: {} });
    expect(blocked.notSentReason).toMatch(/^Not sent: /);
    expect(blocked.notSentReason).not.toContain(PHONE);
    const event = snapshot.timeline.find((t) => t.messageId === blocked.id)!;
    expect(event.title).toBe("DockClock composed a location request (not sent)");
    expect(event.title).not.toMatch(/DockClock sent/);
  });

  it("emits JSON that type-checks against the site's ReplaySnapshot contract", async () => {
    const snapshot = buildSnapshot(await sources());
    const dir = mkdtempSync(join(tmpdir(), "desk-snapshot-"));
    const contract = join(root, "site", "src", "snapshot").replace(/\\/g, "/");
    writeFileSync(join(dir, "check.ts"), `import type { ReplaySnapshot } from "${contract}";\nexport const snapshot = ${JSON.stringify(snapshot)} satisfies ReplaySnapshot;\n`);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2023", module: "ESNext", moduleResolution: "Bundler", strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true, types: [] }, files: ["check.ts"] }),
    );
    expect(() => execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", join(dir, "tsconfig.json")], { encoding: "utf8" })).not.toThrow();
  }, 60_000);
});
