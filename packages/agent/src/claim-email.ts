// The claim as the counterparty receives it: one set of facts, read from the sealed pack and the
// clause, rendered as the email (plain text and HTML) and as the one-page PDF. The agent supplies
// only the opening sentence; the amount, times and digest here never come from the model.

import type { ClauseSpec } from "@dockclock/clause-engine";
import { acceptsAnyLocation, isoToLocalDateTime, type Facility } from "@dockclock/evidence";
import { buildMime, FICTIONAL_NOTE, loadPageUrl, noticeTerms, pinSource, PUBLIC_KEY_URL, renderHtml, renderText, signatureLines, type Letter } from "@dockclock/mail";
import { formatUsd } from "./claim.js";

// The sealed pack fields the claim reads.
export interface SealedPackView {
  packId: string;
  channel?: string;
  events: {
    arrived: { serverAt: string } | null;
    released: { serverAt: string } | null;
    // On packs whose dock clock stops at the driver's Released tap: the tap. The pin then confirms it.
    releasedTap?: { serverAt: string } | null;
    notice?: { sentAt: string; deliveredAt: string | null } | null;
  };
  evaluation: { amountUsd: number; detentionMinutes: number; billableMinutes: number };
}

export interface ClaimFactsInput {
  loadId: string;
  workspace?: string | undefined;
  synthetic: boolean;
  clause: ClauseSpec;
  facility: Facility;
  pack: SealedPackView;
  // The pack digest from the sealed record: the SHA-256 of the canonical pack, the value KMS signed.
  packDigest: string;
  // SHA-256 of the signing key's public half (DER SubjectPublicKeyInfo).
  spkiSha256: string;
  issuedAt: Date;
}

export interface ClaimFacts {
  loadId: string;
  claimNumber: string;
  counterparty: string;
  facilityName: string;
  arrived: string;
  released: string;
  // Set when the clock stopped at a Released tap: the time of the pin that confirmed it.
  releasePin: string | null;
  source: string;
  freeTime: string;
  rate: string;
  cap: string;
  notice: string;
  noticeRecord: string | null;
  detention: string;
  billable: string | null;
  amount: string;
  packId: string;
  packDigest: string;
  spkiSha256: string;
  loadPage: string | null;
  issued: string;
}

const duration = (minutes: number) => (minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minutes`);
const minutes = (value: number) => `${value.toFixed(2)} minutes`;

export function claimFactsOf(input: ClaimFactsInput): ClaimFacts {
  const { clause, facility, pack } = input;
  const local = (iso: string | null | undefined) => (iso ? isoToLocalDateTime(iso, facility.timeZone) : "not recorded");
  const evaluation = pack.evaluation;
  const caps = [clause.capUsdPerOccurrence !== null ? `${formatUsd(clause.capUsdPerOccurrence)} per occurrence` : null, clause.capHoursPerDay !== null ? `${clause.capHoursPerDay} hours per day` : null].filter(Boolean);
  const notice = pack.events.notice;
  return {
    loadId: input.loadId,
    // One claim per load (the tool reserves it), so the load id makes the number unique.
    claimNumber: `DC-${input.loadId}`,
    counterparty: clause.counterparty,
    facilityName: facility.name,
    arrived: local(pack.events.arrived?.serverAt),
    // The time the clock stopped, as the engine counted it.
    released: local(pack.events.releasedTap?.serverAt ?? pack.events.released?.serverAt),
    releasePin: pack.events.releasedTap ? local(pack.events.released?.serverAt) : null,
    // A BILLABLE pack on a fenced facility has both pins inside the fence (the engine holds any other).
    source: pinSource({ synthetic: input.synthetic, channel: pack.channel === "rcs" ? "rcs" : "whatsapp", anyLocation: acceptsAnyLocation(facility), insideGeofence: true, pins: 2 }),
    freeTime: `${duration(clause.freeTimeMinutes)} from ${clause.freeTimeAnchor === "arrival" ? "arrival" : "the appointment time"}`,
    rate: `${formatUsd(clause.ratePerHourUsd)} per hour`,
    cap: caps.length ? caps.join(", ") : "None",
    notice: noticeTerms(clause.noticeLeadMinutes),
    noticeRecord: notice ? `Emailed ${local(notice.sentAt)}${notice.deliveredAt ? `, delivered ${local(notice.deliveredAt)}` : ""}` : null,
    detention: minutes(evaluation.detentionMinutes),
    billable: Math.abs(evaluation.billableMinutes - evaluation.detentionMinutes) > 0.005 ? minutes(evaluation.billableMinutes) : null,
    amount: formatUsd(evaluation.amountUsd),
    packId: pack.packId,
    packDigest: input.packDigest,
    spkiSha256: input.spkiSha256,
    loadPage: loadPageUrl(input.loadId, input.workspace),
    issued: local(input.issuedAt.toISOString()),
  };
}

export const claimSubject = (facts: ClaimFacts) => `Detention claim: Load ${facts.loadId} at ${facts.facilityName}, ${facts.amount}`;
export const claimPdfName = (loadId: string) => `detention-claim-${loadId}.pdf`;

// The agent's opening as one paragraph: line breaks and runs of spaces collapse, nothing else changes.
export const openingOf = (body: string) => body.replace(/\s+/g, " ").trim();

export function claimLetter(facts: ClaimFacts, opening: string, from: string, replyTo: string | undefined): Letter {
  return {
    kind: "Detention claim",
    salutation: `Dear ${facts.counterparty},`,
    summary: openingOf(opening),
    facts: [
      { label: "Claim number", value: facts.claimNumber },
      { label: "Load", value: facts.loadId },
      { label: "Facility", value: facts.facilityName },
      { label: "Arrived", value: facts.arrived },
      { label: "Released", value: facts.released },
      { label: "Detention", value: `${facts.billable ?? facts.detention} after ${facts.freeTime.replace(/ from .*/, "")} of free time, at ${facts.rate}` },
      { label: "Amount due", value: facts.amount, strong: true },
    ],
    closing: `Please arrange payment of ${facts.amount} under the rate confirmation. The claim summary (PDF) and the signed evidence pack (JSON) are attached.`,
    signature: signatureLines(from, replyTo),
    links: [...(facts.loadPage ? [{ label: "Verify this claim", href: facts.loadPage }] : []), { label: "Public key", href: PUBLIC_KEY_URL }],
    notes: [`Evidence pack ${facts.packId}, sha256 ${facts.packDigest.slice(0, 16)}…`, FICTIONAL_NOTE],
  };
}

export interface ClaimMimeParts {
  from: string;
  to: string;
  replyTo?: string | undefined;
  date: Date;
  facts: ClaimFacts;
  opening: string;
  pdf: Uint8Array;
  packFileName: string;
  packJson: string;
}

// The claim email: text and HTML alternatives, then the PDF summary and the signed pack exactly as
// sealed. The public key is linked, not attached: the console and the repository publish it.
export function buildClaimMime(parts: ClaimMimeParts, boundary?: string): string {
  const letter = claimLetter(parts.facts, parts.opening, parts.from, parts.replyTo);
  const subject = claimSubject(parts.facts);
  return buildMime(
    {
      from: parts.from,
      to: parts.to,
      replyTo: parts.replyTo,
      subject,
      date: parts.date,
      text: renderText(letter),
      html: renderHtml(letter, subject),
      attachments: [
        { filename: claimPdfName(parts.facts.loadId), contentType: "application/pdf", content: Buffer.from(parts.pdf) },
        { filename: parts.packFileName, contentType: "application/json", content: parts.packJson },
      ],
    },
    boundary,
  );
}
