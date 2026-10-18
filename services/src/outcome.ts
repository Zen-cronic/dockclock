import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { clauseById, type ReasonCode } from "@dockclock/clause-engine";
import { getLoad } from "./store.js";
import { send, sendRcs, textMessage } from "./sender.js";
import { rcsText } from "./rcs.js";
import type { Language } from "./messages.js";
import { ddb } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

// What the contract decided, in the driver's own thread: after sealing, and again once the claim is
// filed. On a judge demo load this is how the judge sees the result of every step.
type OutcomeInput =
  | { kind: "verdict"; loadId: string; verdict: string; amountUsd: number; reasons: string[] }
  | { kind: "filed"; loadId: string }
  | { kind: "held"; loadId: string };

const REASONS: Record<Language, Record<ReasonCode, string>> = {
  en_US: {
    MISSING_TIMESTAMP: "an arrival or release pin is missing",
    PIN_OUTSIDE_GEOFENCE: "a pin was outside the facility",
    BOL_TIMESTAMP_CONFLICT: "the bill-of-lading times differ from the pins",
    LATE_ARRIVAL: "the truck arrived after the appointment",
    WITHIN_FREE_TIME: "the wait stayed within free time",
    NOTICE_MISSING: "the contract needs a notice before detention and none was sent",
    NOTICE_LATE: "the notice went out after the contract's deadline",
    NO_STATEMENT_OF_RECORD: "the contract needs a signed bill of lading with both times",
    CLAIM_WINDOW_EXPIRED: "the claim window has closed",
    SHIPPER_CONFIRMATION_REQUIRED: "the contract needs the shipper's confirmation",
    CAP_APPLIED: "the contract's cap applies",
  },
  es_MX: {
    MISSING_TIMESTAMP: "falta una ubicación de llegada o de salida",
    PIN_OUTSIDE_GEOFENCE: "una ubicación quedó fuera de la instalación",
    BOL_TIMESTAMP_CONFLICT: "las horas del BOL no coinciden con las ubicaciones",
    LATE_ARRIVAL: "el camión llegó después de la cita",
    WITHIN_FREE_TIME: "la espera quedó dentro del tiempo libre",
    NOTICE_MISSING: "el contrato exige un aviso antes de la demora y no se envió",
    NOTICE_LATE: "el aviso salió después del plazo del contrato",
    NO_STATEMENT_OF_RECORD: "el contrato exige un BOL firmado con ambas horas",
    CLAIM_WINDOW_EXPIRED: "el plazo para reclamar ya cerró",
    SHIPPER_CONFIRMATION_REQUIRED: "el contrato exige la confirmación del embarcador",
    CAP_APPLIED: "se aplica el tope del contrato",
  },
  fr_CA: {
    MISSING_TIMESTAMP: "une position d'arrivée ou de départ manque",
    PIN_OUTSIDE_GEOFENCE: "une position était hors de l'installation",
    BOL_TIMESTAMP_CONFLICT: "les heures du connaissement diffèrent des positions",
    LATE_ARRIVAL: "le camion est arrivé après le rendez-vous",
    WITHIN_FREE_TIME: "l'attente est restée dans le temps alloué",
    NOTICE_MISSING: "le contrat exige un avis avant le temps d'attente et aucun n'a été envoyé",
    NOTICE_LATE: "l'avis est parti après le délai du contrat",
    NO_STATEMENT_OF_RECORD: "le contrat exige un connaissement signé avec les deux heures",
    CLAIM_WINDOW_EXPIRED: "le délai de réclamation est écoulé",
    SHIPPER_CONFIRMATION_REQUIRED: "le contrat exige la confirmation de l'expéditeur",
    CAP_APPLIED: "le plafond du contrat s'applique",
  },
};

const TEXT: Record<Language, { billable: (id: string, usd: string, approver: string) => string; notBillable: (id: string, why: string) => string; needsHuman: (id: string, why: string) => string; filed: (id: string, usd: string, to: string, digest: string) => string; held: (id: string) => string; you: string; dispatch: string }> = {
  en_US: {
    billable: (id, usd, approver) => `Load ${id} is sealed and signed. The contract owes ${usd} in detention. ${approver}`,
    notBillable: (id, why) => `Load ${id} is sealed and signed. No claim: ${why}.`,
    needsHuman: (id, why) => `Load ${id} is sealed and signed. A person will review it before any claim: ${why}.`,
    filed: (id, usd, to, digest) => `Claim filed for load ${id}: ${usd} emailed to ${to} with the signed evidence pack (digest ${digest}).`,
    held: (id) => `No claim was sent for load ${id}.`,
    you: "Approve it in the next message.",
    dispatch: "Dispatch is approving the claim.",
  },
  es_MX: {
    billable: (id, usd, approver) => `La carga ${id} quedó sellada y firmada. El contrato debe ${usd} por demora. ${approver}`,
    notBillable: (id, why) => `La carga ${id} quedó sellada y firmada. Sin reclamo: ${why}.`,
    needsHuman: (id, why) => `La carga ${id} quedó sellada y firmada. Una persona la revisará antes de reclamar: ${why}.`,
    filed: (id, usd, to, digest) => `Reclamo enviado para la carga ${id}: ${usd} por correo a ${to} con el paquete de evidencia firmado (huella ${digest}).`,
    held: (id) => `No se envió reclamo para la carga ${id}.`,
    you: "Apruébelo en el siguiente mensaje.",
    dispatch: "Despacho está aprobando el reclamo.",
  },
  fr_CA: {
    billable: (id, usd, approver) => `Le chargement ${id} est scellé et signé. Le contrat doit ${usd} en temps d'attente. ${approver}`,
    notBillable: (id, why) => `Le chargement ${id} est scellé et signé. Aucune réclamation : ${why}.`,
    needsHuman: (id, why) => `Le chargement ${id} est scellé et signé. Une personne le révisera avant toute réclamation : ${why}.`,
    filed: (id, usd, to, digest) => `Réclamation envoyée pour le chargement ${id} : ${usd} par courriel à ${to} avec le dossier de preuve signé (empreinte ${digest}).`,
    held: (id) => `Aucune réclamation n'a été envoyée pour le chargement ${id}.`,
    you: "Approuvez-la dans le prochain message.",
    dispatch: "La répartition approuve la réclamation.",
  },
};

export function outcomeText(input: OutcomeInput, language: Language, demo: boolean, extra: { counterparty: string; digest: string; amountUsd: number }): string {
  const t = TEXT[language];
  const usd = (n: number) => `$${n.toFixed(2)}`;
  const why = (reasons: string[]) => reasons.map((r) => REASONS[language][r as ReasonCode] ?? r).join("; ");
  if (input.kind === "filed") return t.filed(input.loadId, usd(extra.amountUsd), extra.counterparty, extra.digest.slice(0, 12));
  if (input.kind === "held") return t.held(input.loadId);
  if (input.verdict === "BILLABLE") return t.billable(input.loadId, usd(input.amountUsd), demo ? t.you : t.dispatch);
  if (input.verdict === "NOT_BILLABLE") return t.notBillable(input.loadId, why(input.reasons));
  return t.needsHuman(input.loadId, why(input.reasons));
}

export async function handler(input: OutcomeInput): Promise<{ sent: boolean }> {
  const load = await getLoad(input.loadId);
  if (!load?.sealedPackId) return { sent: false };
  const pack = (await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.pack(load.loadId, load.sealedPackId) }))).Item as { digest?: string; amountUsd?: number } | undefined;
  const text = outcomeText(input, load.language ?? "en_US", load.demo === true, {
    counterparty: clauseById(load.clauseId).counterparty,
    digest: pack?.digest ?? "",
    amountUsd: pack?.amountUsd ?? 0,
  });
  const target = { address: load.address, driverKey: load.driverKey };
  const id = load.channel === "rcs" ? await sendRcs(target, rcsText(text), `outcome_${input.kind}`, load.loadId) : await send(target, textMessage(text), `outcome_${input.kind}`, load.loadId);
  log("outcome_told", { loadId: load.loadId, kind: input.kind, sent: id !== null });
  return { sent: id !== null };
}
