import { RELEASE_PIN_WINDOW_MINUTES, type ReasonCode } from "@dockclock/clause-engine";
import type { Language } from "./messages.js";

const PIN_MINUTES = RELEASE_PIN_WINDOW_MINUTES;

// The clause engine's reason codes in words, for the driver's chat and the dispatch email.
export const REASONS: Record<Language, Record<ReasonCode, string>> = {
  en_US: {
    MISSING_TIMESTAMP: "an arrival or release pin is missing",
    PIN_OUTSIDE_GEOFENCE: "a pin was outside the facility",
    RELEASE_PIN_LATE: `the release location was not shared within ${PIN_MINUTES} minutes of tapping Released`,
    BOL_TIMESTAMP_CONFLICT: "the bill-of-lading times differ from the recorded arrival or release time",
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
    RELEASE_PIN_LATE: `la ubicación de salida no llegó dentro de los ${PIN_MINUTES} minutos después de tocar Liberado`,
    BOL_TIMESTAMP_CONFLICT: "las horas del BOL no coinciden con la llegada o la salida registradas",
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
    RELEASE_PIN_LATE: `la position de départ n'a pas été partagée dans les ${PIN_MINUTES} minutes après Libéré`,
    BOL_TIMESTAMP_CONFLICT: "les heures du connaissement diffèrent de l'arrivée ou du départ enregistrés",
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

// Several reasons read as one clause: "a pin was outside the facility; the notice went out late".
export function reasonWords(reasons: readonly string[], language: Language): string {
  return reasons.map((r) => REASONS[language][r as ReasonCode] ?? r).join("; ");
}
