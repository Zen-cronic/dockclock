import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { CEDAR_POLICIES, checkClaim, formatUsd, readBol, SYSTEM_PROMPT, TOOLS, type ClaimRequest, type SealedClaimBasis } from "../src/index.js";

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

  // A load id may hold a long digit run itself: a run wholly inside an occurrence of the load id is
  // the load's name, one that only overlaps it is not. Fictional: 555-01xx numbers and made-up ids.
  it.each([
    ["files", "PO-123456789012", ""],
    ["refuses", "PO-123456789012", "Account 111122223333."],
    ["files", "PO-416-555-0143", ""],
    ["refuses", "PO-416-555-0143", "Call (416) 555-0199."],
    ["files", "0143", ""],
    ["refuses", "0143", "Account 999901439999."],
    ["refuses", "0143", "Account ٩٩٩٩٠١٤٣٩٩٩٩."],
    ["refuses", "0143", "Call +14165550143."],
    ["refuses", "0143", "Call 416-555-0143."],
    ["refuses", "0143", "Call 416\u2063555\u20630143."],
    ["refuses", "0143", "Key arn:aws:kms:x/0143."],
    // A numeric load id beside the amount: the load and the amount are one token each.
    ["files", "PO-4471982", "", "load PO-4471982: $80.00"],
    ["files", "4471982", "", "load 4471982 ($80.00)"],
    ["files", "PO-123456789012", "", "load PO-123456789012, $80.00,"],
    ["refuses", "4471982", "", "load 4471982 ($80.00) 555"],
    ["refuses", "0143", "", "load 0143 0143 0143 ($80.00)"],
  ])("%s load %s with: %s %s", (outcome, id, text, opening = "") => {
    const base = opening ? body.replace("load LIVE-abc", opening).replace(" Amount owed: $80.00.", "") : body;
    const named = `${base.replaceAll("LIVE-abc", id)} ${text}`.trim();
    const result = checkClaim({ ...request, loadId: id, body: named }, { ...basis, loadId: id });
    if (outcome === "files") expect(result).toEqual({ ok: true });
    else expect(result.ok === false && result.reason).toMatch(/AWS resource name, account id or phone number/);
  });

  // Every opening the leak check has misjudged, both ways, and the shapes around them. Fictional
  // numbers only: 555-01xx phone numbers and made-up account ids. A test name shows each character
  // that is not printable ASCII by its code point.
  const shown = (text: string) => text.replace(/[^\x20-\x7e]/g, (c) => `<U+${c.codePointAt(0)!.toString(16).padStart(4, "0")}>`);
  // Characters a reader does not see, or reads as punctuation, between two digit groups.
  const joiners = [
    "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u2061", "\u2062",
    "\u2063", "\u2064", "\u034f", "\ufe0f", "\u3164", "\u02b9", "_", ":", "+", "*", "'", "~", "|", "#", "=",
  ];
  it.each([
    ["files", "Amount owed: $9.88."],
    ["files", "Rate $60/h after +15 min grace, $30 cap, $1,234.56 billed, $1,234,567.89 in all."],
    ["files", "Arrived 10/23/2026 1:05 PM, released 2026-10-23 14:35:00.123."],
    // Shapes the leak check refused from the start.
    ["refuses", "Call +14165550100."],
    ["refuses", "Call +1 416-555-0143."],
    ["refuses", "Call +1 (416) 555-0143."],
    ["refuses", "Call +1.416.555.0143."],
    ["refuses", "Call (416) 555-0143."],
    ["refuses", "Call (416)555-0143."],
    ["refuses", "Call 416-555-0143."],
    ["refuses", "Call 416.555.0143."],
    ["refuses", "Call 416 555 0143."],
    ["refuses", "Call 1-416-555-0143."],
    ["refuses", "Call 4165550143."],
    ["refuses", "Account 9999-0143-9999."],
    ["refuses", "Account 9999 0143 9999."],
    ["refuses", "Key arn:aws:kms:us-east-1:111122223333:key/x."],
    ["refuses", "Key ARN:aws:kms:us-east-1:x."],
    ["refuses", "Key Arn:Aws:kms:x."],
    ["refuses", "Key arn:aws-us-gov:kms:x."],
    ["files", "Grace (+15) 2026-10-23 13:05 EDT."],
    ["files", "Arrived 2026-10-23T13:05:00-04:00, released +2 hours past free time (+15 min grace)."],
    // A bare number beside a date joins it: the agent never writes times or minutes in the opening.
    ["refuses", "Released 14:30–14:35 on 2026-10-23, 80 minutes past free time."],
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
    // Groups joined by an invisible character or by punctuation, digits of another script, and a
    // dollar sign in front of a number that is not money.
    ...joiners.map((c) => ["refuses", `Call 416${c}555${c}0143.`]),
    ["refuses", "Call ٤١٦٥٥٥٠١٤٣."],
    ["refuses", "Call ४१६५५५०१४३."],
    ["refuses", "Call 416-५५५-0143."],
    ["refuses", "Call $416-555-0143."],
    ["refuses", "Call $416 555 0143."],
    ["refuses", "Account $1111 2222 3333."],
    ["refuses", "Ref $4,165,550,143."],
    ["refuses", "Call 41655501 $43."],
    ["refuses", "Call 4165550 +143."],
    // A list joins too: only a letter ends a run.
    ["refuses", "Call 416, 555, 0143."],
    // A safe token beside a bare group does not end the run, nor do several tokens of one kind.
    ["refuses", "Call 416-555-01:43."],
    ["refuses", "Call 416 555 01:43."],
    ["refuses", "Account 1111-22:33-4444."],
    ["refuses", "Account 11112222 3:33 3."],
    ["refuses", "Call 416-555-1/1/43."],
    ["refuses", "Account 1111 2026-10-23 99."],
    ["refuses", "Call 4:16 5:55 01:43."],
    ["refuses", "Call $416 $555 $0143."],
    ["refuses", "Billed $1,234.56, $2,345.67."],
    ["refuses", "Call 41:65 5:50 +143."],
    // Numerals that are not decimal digits.
    ["refuses", "Call ❹❶❻❺❺❺⓿❶❹❸."],
    ["refuses", "Call ➃➀➅➄➄➄➉➀➃➂."],
    ["refuses", "Call ⓸⓵⓺⓹⓹⓹⓪⓵⓸⓷."],
    ["refuses", "Call 416〇555〇0143."],
    // Letters of other scripts, and a lone letter set tight between two groups.
    ["refuses", "Call 416ǀ555ǀ0143."],
    ["refuses", "Call 416ㅡ555ㅡ0143."],
    ["refuses", "Call 416一555一0143."],
    ["refuses", "Call 416ꞏ555ꞏ0143."],
    ["refuses", "Call 416ᐧ555ᐧ0143."],
    ["refuses", "Call 416x555x0143."],
    ["refuses", "Call 416-555-O143."],
    ["refuses", "Call 4l6-555-0l43."],
    ["refuses", "Call 416-555-0I43."],
    // An ARN behind a colon that is not ASCII, a space, or a digit.
    ["refuses", "Key arn∶aws∶s3∶∶∶evidence-bucket."],
    ["refuses", "Key arnː aws:s3:::evidence-bucket."],
    ["refuses", "Key arn :aws:s3:::evidence-bucket."],
    ["refuses", "Key 1arn:aws:s3:::evidence-bucket."],
    // What the agent and the clause engine write, which must still file.
    ["files", "Billed $9.88 ($80.00 cap)."],
    ["files", "From $80.00-$120.00."],
    ["files", "Arrived 2026-10-23 13:05, released 2026-10-23 14:35."],
    ["files", "Window 13:05-14:35 on 10/23/2026."],
    ["files", "Arrived 2026-10-23T13:05:00.000-04:00."],
    ["files", "Arrived Oct 23, 2026 at 1:05 PM."],
    ["files", "Arrived 10/23/2026 13:05 and released 10/23/2026 14:35."],
    ["files", "Detention 80 min (+15 min grace) = $80.00."],
    ["files", "Wait 2 h 13 m (13:05–15:18)."],
    ["files", "Loaded 5 x 12 pallets."],
    ["files", "The driver will warn dispatch."],
  ])("%s an opening with: %s", (outcome, text) => {
    const result = checkClaim({ ...request, body: `${body} ${text}` }, basis);
    if (outcome === "files") expect(result, shown(text)).toEqual({ ok: true });
    else expect(result.ok === false && result.reason, shown(text)).toMatch(/AWS resource name, account id or phone number/);
  });

  // formatUsd writes no thousands separator, so an amount of $1,000 or more is $1234.56 in the opening.
  it.each([
    ["files", "We are claiming detention for load LIVE-abc at Lakeshore DC under the rate confirmation in the amount of $1234.56."],
    ["files", "We are claiming detention for load LIVE-abc at Lakeshore DC under the rate confirmation: $1234.56 ($60.00/h)."],
    ["files", "We are claiming detention for load LIVE-abc at Lakeshore DC under the rate confirmation in the amount of $1234.56 ($1,234.56)."],
    ["refuses", "We are claiming detention for load LIVE-abc at Lakeshore DC under the rate confirmation: $1234.56, 4165."],
  ])("%s a four-figure amount: %s", (outcome, opening) => {
    const result = checkClaim({ ...request, amountCents: 123456, body: opening }, { ...basis, amountCents: 123456 });
    if (outcome === "files") expect(result).toEqual({ ok: true });
    else expect(result.ok === false && result.reason).toMatch(/AWS resource name, account id or phone number/);
  });

  // The opening the agent writes, from SYSTEM_PROMPT and the real LIVE-mvpoqheg claim, across load
  // ids, facilities and every amount shape formatUsd writes: all 2002 must file.
  it("files the agent's template for every load id, facility and amount", () => {
    const ids = ["LIVE-mvpoqheg", "LIVE-mvlb0qzq", "LIVE-mve1ve6d", "LIVE-mvq1o2l3", "LIVE-mvq12345", "LIVE-1o1l1o1l", "SMOKE-RCS-mvh32fui", "4471", "4471982", "PO-4471982", "PO-123456789012", "1234567890", "0143"];
    const facilities = [
      "Judge demo yard (any location counts)", "Lakeshore DC, Columbus OH", "Prairie Distribution, Joliet IL", "Dock 12", "Gate 4B", "Building 1001", "DC 1O1",
      "Building 1001, Dock 12", "Ontario DC, Route 401", "Illinois DC off I-95", "Door 12 (Building 1001)",
    ];
    const amounts = [1, 9, 10, 99, 100, 988, 1000, 3000, 8000, 99999, 123456, 500000, 999999, 9999999];
    const refused: string[] = [];
    for (const id of ids) {
      for (const facility of facilities) {
        for (const cents of amounts) {
          const opening = `We are claiming detention for load ${id} at ${facility} under the rate confirmation in the amount of ${formatUsd(cents / 100)}.`;
          const sealed = { ...basis, loadId: id, amountCents: cents };
          if (!checkClaim({ ...request, loadId: id, amountCents: cents, body: opening }, sealed).ok) refused.push(opening);
        }
      }
    }
    expect(ids.length * facilities.length * amounts.length).toBe(2002);
    expect(refused).toEqual([]);
  });

  // Openings found by review: the agent's sentence with one fact added, each way it may be written.
  // Fictional numbers only: 555-01xx phone numbers and made-up account ids.
  const pre = "Detention is claimed for load LIVE-mvpoqheg at Judge demo yard (any location counts) under the rate confirmation";
  const demoClaim = (opening: string, cents = 3000, loadId = "LIVE-mvpoqheg") =>
    checkClaim({ ...request, loadId, amountCents: cents, body: opening }, { ...basis, loadId, amountCents: cents });
  const judged = (outcome: string, opening: string, cents?: number, loadId?: string) => {
    const result = demoClaim(opening, cents, loadId);
    if (outcome === "files") expect(result, shown(opening)).toEqual({ ok: true });
    else expect(result.ok === false && result.reason, shown(opening)).toMatch(/AWS resource name, account id or phone number/);
  };

  // A time range is one token, however its ends are joined; it states a time, so it cannot sit
  // beside another time, and its ends hold hours and minutes only.
  it.each([
    ["files", `${pre} in the amount of $30.00 (2:05–2:40 PM).`],
    ["files", `${pre} in the amount of $30.00 (14:05–14:40).`],
    ["files", `${pre} for 2026-10-27 14:05-15:40, in the amount of $30.00.`],
    ["files", `${pre} for 14:05-15:40: $9.88.`, 988],
    ["files", `${pre} for 2026-10-27 14:05 - 14:40, in the amount of $30.00.`],
    ["files", `${pre} for 2026-10-27 14:05−14:40, in the amount of $30.00.`],
    ["files", `${pre} in the amount of $30.00 (14:05−14:40).`],
    ["files", `${pre} for 10/27/2026 2:05 PM–2:40 PM, in the amount of $30.00.`],
    ["files", `${pre} in the amount of $30.00 (2026-10-27 14:05–2026-10-27 14:40).`],
    ["refuses", `${pre} in the amount of $30.00. Call 4:16–5:55 01:43.`],
    ["refuses", `${pre} in the amount of $30.00. Call 4:16 - 5:55 - 01:43.`],
    ["refuses", `${pre} in the amount of $30.00. Call 4:16-5:55-01:43.`],
    ["refuses", `${pre} in the amount of $30.00 (2026-10-27 14:05–2026-10-28 14:40).`],
  ])("%s a time range: %s", (outcome, opening, cents?: number) => judged(outcome, opening, cents));

  // A date with the month named is a date, as 2026-10-27 is; a day past 31 is not a day.
  const yard = "Detention is claimed for load LIVE-mvpoqheg at Judge demo yard (any location counts)";
  it.each([
    ["files", `${yard} on October 27, 2026, 14:05 EDT, under the rate confirmation for $30.00.`],
    ["files", `${yard} under the rate confirmation, October 27, 2026: $30.00.`],
    ["files", `${yard} under the rate confirmation, Oct 27, 2026: $30.00.`],
    ["files", `${yard} under the rate confirmation, Oct. 27 2026: $30.00.`],
    ["files", `${yard} under the rate confirmation, Sept 27, 2026: $30.00.`],
    ["files", `${yard} under the rate confirmation, 27 October 2026: $30.00.`],
    ["files", `${yard} under the rate confirmation, Oct 27, 2026, 14:05–14:40: $30.00.`],
    ["refuses", `${yard} under the rate confirmation, October 27, 2026, 555-0143: $30.00.`],
    ["refuses", `${yard} under the rate confirmation, Oct 27, 2026, 2026-10-28: $30.00.`],
    ["refuses", `${yard} under the rate confirmation, Oct 41, 2026: $30.00.`],
  ])("%s a named-month date: %s", (outcome, opening) => judged(outcome, opening));

  // Only the real month names, whole or cut short, are months: a word that starts like one is a word.
  it.each([
    ["files", `${yard} under the rate confirmation, December 1, 2026, 14:05–14:40: $30.00.`],
    ["files", `${yard} under the rate confirmation, Dec. 1, 2026, 14:05–14:40: $30.00.`],
    ["files", `${yard} under the rate confirmation, Sept 1, 2026, 14:05–14:40: $30.00.`],
    ["files", `${yard} under the rate confirmation, June 3, 2026, 14:05–14:40: $30.00.`],
    ["files", `${yard} under the rate confirmation, 3 May 2026, 14:05–14:40: $30.00.`],
    ["refuses", `${yard} under the rate confirmation, Marketing 4, 2016 5:55-0143: $30.00.`],
    ["refuses", `${yard} under the rate confirmation, Decimal 1, 2026, 14:05–14:40: $30.00.`],
    ["refuses", `${yard} under the rate confirmation, Octane 1, 2026, 14:05–14:40: $30.00.`],
    ["refuses", `${yard} under the rate confirmation, Mayor 1, 2026, 14:05–14:40: $30.00.`],
  ])("%s a month name or a word like one: %s", (outcome, opening) => judged(outcome, opening));

  // The load id and the amount may be said twice in a run, since both come from the sealed pack;
  // nothing else may, and neither may be said three times.
  it.each([
    ["files", "Detention is claimed for load 4471982 (4471982) at Lakeshore DC, Columbus OH under the rate confirmation in the amount of $30.00.", "4471982"],
    ["files", "Detention is claimed for load 4471982 (4471982): $30.00 ($30.00), at Lakeshore DC, Columbus OH under the rate confirmation.", "4471982"],
    ["files", "Detention is claimed for load 2026, 2026-10-27, at Lakeshore DC, Columbus OH under the rate confirmation in the amount of $30.00.", "2026"],
    ["files", `${pre} in the amount of $30.00 ($30.00), 2026-10-27.`],
    ["files", `${pre} in the amount of $30.00 (2026-10-27 14:05–2026-10-27 14:40).`],
    ["refuses", "Detention is claimed for load 4471982 (4471982) 555 at Lakeshore DC, Columbus OH under the rate confirmation in the amount of $30.00.", "4471982"],
    ["refuses", "Detention is claimed for load 4471982 4471982 4471982 at Lakeshore DC, Columbus OH under the rate confirmation in the amount of $30.00.", "4471982"],
    ["refuses", `${pre} in the amount of $30.00 $30.00 $30.00.`],
    ["refuses", `${pre} in the amount of $30.00 (2026-10-27, 2026-10-27).`],
  ])("%s a value said again: %s", (outcome, opening, loadId?: string) => judged(outcome, opening, 3000, loadId));

  // No safe token can carry a phone number or an account id: money stops at what formatUsd writes,
  // a time at 9 digits, and a run with no date holds fewer than 10 digits besides the load id and
  // the amount, whatever tokens of different kinds it is made of.
  it.each([
    ["refuses", `${pre} in the amount of $30.00. Ref $41,655,501.43.`],
    ["refuses", `${pre} in the amount of $30.00. Ref $141,655,501.43.`],
    ["refuses", `${pre} in the amount of $30.00. Ref +416 $5550143.`],
    ["refuses", `${pre} in the amount of $30.00. Ref $4165550+143.`],
    ["refuses", `${pre} in the amount of $30.00. Ref 4:16 $5550143.`],
    ["refuses", `${pre} in the amount of $30.00. Ref 4:16:55.5-01:43.`],
    ["refuses", `${pre} in the amount of $30.00. Ref 12:34:56.789 +012.`],
    ["refuses", `${pre} in the amount of $30.00. Ref $1234567 +89 0:12.`],
    ["refuses", `${pre} in the amount of $30.00. Ref $41.65 5:55:01.43.`],
    ["refuses", `${pre} in the amount of $30.00 (2026-10-27, $1,234,567.89).`],
    ["files", `${pre} in the amount of $30.00 (2026-10-27, $99,999.99).`],
    ["files", `${pre} in the amount of $30.00 (2026-10-27, $5,000.00).`],
    ["files", `${pre} in the amount of $30.00 (2026-10-27, $99999.99).`],
    ["files", `${pre} in the amount of $30.00 (2026-10-27 14:35:00.123).`],
    ["files", `${pre} in the amount of $30.00 (2026-10-27T14:05:00.000-04:00).`],
    ["files", `${pre} in the amount of $30.00 (+35 min, 14:05).`],
  ])("%s a run of safe tokens: %s", (outcome, opening) => judged(outcome, opening));

  // A letter of another script set tight between two digits counts as a digit, as O, o, I and l
  // do: Cyrillic О (U+041E), Greek Ο (U+039F), Cyrillic І (U+0406) and Cyrillic ӏ (U+04CF).
  it.each([
    ["refuses", `${pre} in the amount of $30.00. Call 416-555-О143.`],
    ["refuses", `${pre} in the amount of $30.00. Call 416-555-Ο143.`],
    ["refuses", `${pre} in the amount of $30.00. Call 4І6-555-0143.`],
    ["refuses", `${pre} in the amount of $30.00. Call 416-555-0ӏ43.`],
    ["refuses", `${pre} in the amount of $30.00. Call 416-555-ОО143.`],
    ["files", `${pre} in the amount of $30.00. Gate 4О2.`],
    ["files", "Detention is claimed for load LIVE-mvpoqheg at Québec DC, Dock 12, under the rate confirmation in the amount of $30.00."],
    ["files", `${pre} in the amount of $30.00, 2026-10-27 14:05 ЕDT.`],
  ])("%s a letter of another script between digits: %s", (outcome, opening) => judged(outcome, opening));

  it("files the opening the live agent wrote for LIVE-mvpoqheg", () => {
    const opening = "We are claiming detention for load LIVE-mvpoqheg at Judge demo yard (any location counts) under the rate confirmation in the amount of $9.88.";
    const live = { ...basis, loadId: "LIVE-mvpoqheg", amountCents: 988 };
    expect(checkClaim({ ...request, loadId: "LIVE-mvpoqheg", amountCents: 988, body: opening }, live)).toEqual({ ok: true });
  });

  it("refuses an over-long opening by its length before reading it for leaks", () => {
    const long = `${body} Call 416-555-0143. ${"x".repeat(200_000)}`;
    const result = checkClaim({ ...request, body: long }, basis);
    expect(result.ok === false && result.reason).toMatch(/opening must be 80-600 characters/);
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
    // The leak check reads every number in the opening, so the agent writes only the two it needs.
    expect(SYSTEM_PROMPT).toContain("Write no dates, times or other numbers in it: the load id, the facility's name and the amount are the only ones.");
    expect(TOOLS.find((t) => t.name === "send_detention_claim")!.inputSchema.properties!.body!.description).toContain("with no dates, times or other numbers");
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
