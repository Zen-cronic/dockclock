import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { clauseById } from "@dockclock/clause-engine";
import { getLoad } from "./store.js";
import { send, sendRcs, textMessage } from "./sender.js";
import { rcsText } from "./rcs.js";
import type { Language } from "./messages.js";
import { reasonWords } from "./reasons.js";
import { ddb } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";
import { sendClaimReceipts, type ReceiptResult } from "./claim-receipt.js";

// What the contract decided, in the driver's own thread: after sealing, and again once the claim is
// filed. On a judge demo load this is how the judge sees the result of every step.
type OutcomeInput =
  | { kind: "verdict"; loadId: string; verdict: string; amountUsd: number; reasons: string[] }
  | { kind: "filed"; loadId: string }
  | { kind: "held"; loadId: string };

interface OutcomeCopy {
  billable: (id: string, usd: string, approver: string) => string;
  notBillable: (id: string, why: string) => string;
  notBillablePlain: (id: string) => string;
  needsHuman: (id: string, why: string) => string;
  // No reason codes came with the verdict.
  needsHumanPlain: (id: string) => string;
  filed: (id: string, usd: string, to: string, digest: string) => string;
  held: (id: string) => string;
  you: string;
  dispatch: string;
}

// Lead with the result. The pack digest appears once, shortened, in the filed message, so the driver
// (or a judge) can match it against the pack the email carried.
const TEXT: Record<Language, OutcomeCopy> = {
  en_US: {
    billable: (id, usd, approver) => `Load ${id}: the contract owes ${usd} in detention. ${approver}`,
    notBillable: (id, why) => `Load ${id}: no claim, because ${why}.`,
    notBillablePlain: (id) => `Load ${id}: no claim.`,
    needsHuman: (id, why) => `Load ${id}: no claim yet. A person will review it first, because ${why}.`,
    needsHumanPlain: (id) => `Load ${id}: no claim yet. A person will review it first.`,
    filed: (id, usd, to, digest) => `Claim filed: ${usd} for load ${id}, emailed to ${to} with the signed evidence pack (fingerprint ${digest}).`,
    held: (id) => `No claim was sent for load ${id}.`,
    you: "Approve the claim in the next message.",
    dispatch: "Dispatch decides whether to send the claim.",
  },
  es_MX: {
    billable: (id, usd, approver) => `Carga ${id}: el contrato debe ${usd} por demora. ${approver}`,
    notBillable: (id, why) => `Carga ${id}: sin reclamo, porque ${why}.`,
    notBillablePlain: (id) => `Carga ${id}: sin reclamo.`,
    needsHuman: (id, why) => `Carga ${id}: aún sin reclamo. Una persona la revisará primero, porque ${why}.`,
    needsHumanPlain: (id) => `Carga ${id}: aún sin reclamo. Una persona la revisará primero.`,
    filed: (id, usd, to, digest) => `Reclamo enviado: ${usd} por la carga ${id}, por correo a ${to} con el paquete de evidencia firmado (huella ${digest}).`,
    held: (id) => `No se envió reclamo para la carga ${id}.`,
    you: "Apruebe el reclamo en el siguiente mensaje.",
    dispatch: "Despacho decide si se envía el reclamo.",
  },
  fr_CA: {
    billable: (id, usd, approver) => `Chargement ${id} : le contrat doit ${usd} en temps d'attente. ${approver}`,
    notBillable: (id, why) => `Chargement ${id} : aucune réclamation, car ${why}.`,
    notBillablePlain: (id) => `Chargement ${id} : aucune réclamation.`,
    needsHuman: (id, why) => `Chargement ${id} : pas encore de réclamation. Une personne le révisera d'abord, car ${why}.`,
    needsHumanPlain: (id) => `Chargement ${id} : pas encore de réclamation. Une personne le révisera d'abord.`,
    filed: (id, usd, to, digest) => `Réclamation envoyée : ${usd} pour le chargement ${id}, par courriel à ${to} avec le dossier de preuve signé (empreinte ${digest}).`,
    held: (id) => `Aucune réclamation n'a été envoyée pour le chargement ${id}.`,
    you: "Approuvez la réclamation dans le prochain message.",
    dispatch: "La répartition décide d'envoyer ou non la réclamation.",
  },
};

// The digest's first 8 hex characters: enough to match it by eye against the pack.
export const DIGEST_SHOWN = 8;

export function outcomeText(input: OutcomeInput, language: Language, demo: boolean, extra: { counterparty: string; digest: string; amountUsd: number }): string {
  const t = TEXT[language];
  const usd = (n: number) => `$${n.toFixed(2)}`;
  if (input.kind === "filed") return t.filed(input.loadId, usd(extra.amountUsd), extra.counterparty, extra.digest.slice(0, DIGEST_SHOWN));
  if (input.kind === "held") return t.held(input.loadId);
  if (input.verdict === "BILLABLE") return t.billable(input.loadId, usd(input.amountUsd), demo ? t.you : t.dispatch);
  const why = reasonWords(input.reasons, language);
  if (input.verdict === "NOT_BILLABLE") return why ? t.notBillable(input.loadId, why) : t.notBillablePlain(input.loadId);
  return why ? t.needsHuman(input.loadId, why) : t.needsHumanPlain(input.loadId);
}

export async function handler(input: OutcomeInput): Promise<{ sent: boolean; receipts?: ReceiptResult[] }> {
  const load = await getLoad(input.loadId);
  if (!load?.sealedPackId) return { sent: false };
  const pack = (await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.pack(load.loadId, load.sealedPackId) }))).Item as { digest?: string; amountUsd?: number } | undefined;
  const text = outcomeText(input, load.language ?? "en_US", load.demo === true, {
    counterparty: clauseById(load.clauseId).counterparty,
    digest: pack?.digest ?? "",
    amountUsd: pack?.amountUsd ?? 0,
  });
  const target = { address: load.address, driverKey: load.driverKey };
  let id: string | null = null;
  let failure: unknown = null;
  try {
    id = load.channel === "rcs" ? await sendRcs(target, rcsText(text), `outcome_${input.kind}`, load.loadId) : await send(target, textMessage(text), `outcome_${input.kind}`, load.loadId);
  } catch (error) {
    failure = error;
  }
  log("outcome_told", { loadId: load.loadId, outcome: input.kind, sent: id !== null });
  // Once the claim is filed, the PDF summary follows the text (claim-receipt.ts). It never throws,
  // and it runs even when the text failed: the two are separate messages.
  const receipts = input.kind === "filed" ? await sendClaimReceipts(load).catch((error: Error) => (log("claim_receipt_failed", { loadId: load.loadId, error: error.name }), [])) : undefined;
  // A failed text still fails this step as before; the workflow catches it and the load stays filed.
  if (failure) throw failure;
  return { sent: id !== null, ...(receipts ? { receipts } : {}) };
}
