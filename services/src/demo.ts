import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { JUDGE_DEMO_CLAUSE, RELEASE_PIN_WINDOW_MINUTES } from "@dockclock/clause-engine";
import { JUDGE_DEMO_FACILITY } from "@dockclock/evidence";
import type { InboundEvent } from "@dockclock/whatsapp";
import { handler as dispatch } from "./dispatch.js";
import { driverKey, replyAddress } from "./identity.js";
import type { Language } from "./messages.js";
import { RETAKE_WAIT_SECONDS } from "./lifecycle.js";
import { send, textMessage } from "./sender.js";
import { ddb, type Address } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

// The judge try-it path. Anyone may text DEMO (optionally DEMO ES or DEMO FR) to the WhatsApp
// number and get a short, capped demo load in which they are both the driver and the dispatcher.
// Their number is enrolled for 24 hours, so it passes the send gate that otherwise admits only the
// allowlist. Claim and notice emails go to the deployment's own counterparty mailbox, never to the
// judge, and the judge is told on WhatsApp what was sent.
const DEMO_WORDS = /^\s*demo(?:\s+(en|es|fr))?\s*[.!]?\s*$/i;
const ENROLL_HOURS = 24;
export const PER_SENDER_PER_DAY = 5;
const LANGUAGE: Record<string, Language> = { en: "en_US", es: "es_MX", fr: "fr_CA" };

export function demoLanguage(event: InboundEvent): Language | null {
  if (event.body.type !== "text") return null;
  const match = DEMO_WORDS.exec(event.body.text);
  if (!match) return null;
  return LANGUAGE[(match[1] ?? "en").toLowerCase()] ?? "en_US";
}

// Counts one demo against a daily limit; false once the limit is reached.
async function take(day: string, scope: string, limit: number): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.demoQuota(day, scope),
        UpdateExpression: "ADD n :one SET expiresAt = if_not_exists(expiresAt, :ttl)",
        ConditionExpression: "attribute_not_exists(n) OR n < :limit",
        ExpressionAttributeValues: { ":one": 1, ":limit": limit, ":ttl": Math.floor(Date.now() / 1000) + 3 * 86_400 },
      }),
    );
    return true;
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

const MINUTES = JUDGE_DEMO_CLAUSE.freeTimeMinutes;
// The free time plus a few minutes of taps, pins and the photo; a retake adds its own wait.
export const DEMO_MINUTES = MINUTES + 5;
const RETAKE_MINUTES = RETAKE_WAIT_SECONDS.demo / 60;
// The clock stops at the Released tap; the location shared after it must come within this.
const PIN_MINUTES = RELEASE_PIN_WINDOW_MINUTES;
// The demo yard's zone, in words, because every time the judge sees is in that zone.
const ZONE_WORDS: Record<string, Record<Language, string>> = {
  "America/New_York": { en_US: "US Eastern time", es_MX: "hora del Este de EE. UU.", fr_CA: "heure de l'Est des États-Unis" },
};
const zone = (language: Language) => ZONE_WORDS[JUDGE_DEMO_FACILITY.timeZone]?.[language] ?? JUDGE_DEMO_FACILITY.timeZone;

// One message: what the demo is, the four steps, then the fine print after a blank line.
const INTRO: Record<Language, string> = {
  en_US: [
    `DockClock demo, about ${DEMO_MINUTES} minutes (${RETAKE_MINUTES} more if a photo has to be retaken). You are the truck driver and the dispatcher.`,
    "1. Tap Arrived and share your location (any location counts).",
    `2. Free time is ${MINUTES} minutes. Wait past it, then tap Released and share your location within ${PIN_MINUTES} minutes.`,
    `3. Write the arrival and release times from the chat on any paper (${zone("en_US")}). Photograph it in the form and keep the times it fills in.`,
    "4. Approve the claim.",
    "",
    "The contract and receiver are fictional. Emails go to our test mailbox, never to you; we tell you here what was sent.",
    `Send DEMO again to start over (${PER_SENDER_PER_DAY} a day per number, reset at 00:00 UTC).`,
    "We keep your pins and photo; DockClock's public console shows your demo without them, your number or typed text.",
  ].join("\n"),
  es_MX: [
    `Demo de DockClock, unos ${DEMO_MINUTES} minutos (${RETAKE_MINUTES} más si hay que repetir una foto). Usted es el chofer y el despachador.`,
    "1. Toque Llegué y comparta su ubicación (cualquier lugar vale).",
    `2. El tiempo libre es de ${MINUTES} minutos. Espere más, toque Liberado y comparta su ubicación en menos de ${PIN_MINUTES} minutos.`,
    `3. Escriba en cualquier papel las horas de llegada y salida del chat (${zone("es_MX")}). Fotografíelo en el formulario y deje las horas que propone.`,
    "4. Apruebe el reclamo.",
    "",
    "El contrato y el receptor son ficticios. Los correos llegan a nuestro buzón de prueba, nunca a usted; aquí le decimos qué se envió.",
    `Envíe DEMO otra vez para empezar de nuevo (${PER_SENDER_PER_DAY} al día por número, se reinicia a las 00:00 UTC).`,
    "Guardamos sus ubicaciones y su foto; la consola pública de DockClock muestra su demo sin ellas, sin su número ni sus textos.",
  ].join("\n"),
  fr_CA: [
    `Démo DockClock, environ ${DEMO_MINUTES} minutes (${RETAKE_MINUTES} de plus s'il faut reprendre une photo). Vous êtes le chauffeur et le répartiteur.`,
    "1. Touchez Arrivé et partagez votre position (n'importe où).",
    `2. Le temps alloué est de ${MINUTES} minutes. Attendez plus, puis touchez Libéré et partagez votre position d'ici ${PIN_MINUTES} minutes.`,
    `3. Écrivez sur un papier les heures d'arrivée et de départ de la conversation (${zone("fr_CA")}). Photographiez-le dans le formulaire et gardez les heures proposées.`,
    "4. Approuvez la réclamation.",
    "",
    "Le contrat et le destinataire sont fictifs. Les courriels vont à notre boîte de test, jamais à vous; nous vous disons ici ce qui a été envoyé.",
    `Envoyez DEMO de nouveau pour recommencer (${PER_SENDER_PER_DAY} par jour par numéro, remise à zéro à 00 h 00 UTC).`,
    "Nous conservons vos positions et votre photo; la console publique de DockClock montre votre démo sans elles, ni votre numéro ni vos textes.",
  ].join("\n"),
};

// The demo's own copy, exported for the length guard in services/test/copy-length.test.ts.
export const DEMO_INTRO = INTRO;
export const DEMO_LIMIT_TEXT = "The DockClock demo has reached today's limit. Please try again tomorrow.";

// Called by ingest for a DEMO text, before any load routing.
export async function handleDemo(event: InboundEvent, language: Language, candidateKeys: string[]): Promise<void> {
  const address: Address = replyAddress(event);
  const key = await driverKey(address.kind === "phone" ? { kind: "phone", e164: address.e164 } : { kind: "bsuid", id: address.id, e164: null });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ENROLL_HOURS * 3_600_000).toISOString();
  // Enrol every key this sender is known by, so replies to any of them (STOP included) can go out.
  await Promise.all(
    [...new Set([key, ...candidateKeys])].map((k) =>
      ddb.send(new PutCommand({ TableName: env.table(), Item: { ...keys.demoUser(k), enrolledAt: now.toISOString(), expiresAt, ttl: Math.floor(Date.parse(expiresAt) / 1000) } })),
    ),
  );
  const target = { address, driverKey: key };
  const day = now.toISOString().slice(0, 10);
  if (!(await take(day, `SENDER#${key}`, PER_SENDER_PER_DAY)) || !(await take(day, "ALL", env.demoDailyLimit()))) {
    await send(target, textMessage(DEMO_LIMIT_TEXT), "demo_limit", "-");
    log("demo_refused", { reason: "daily limit" });
    return;
  }
  const loadId = `DEMO-${now.getTime().toString(36)}`;
  await send(target, textMessage(INTRO[language]), "demo_intro", loadId);
  const out = await dispatch({
    loadId,
    clauseId: JUDGE_DEMO_CLAUSE.id,
    facilityId: JUDGE_DEMO_FACILITY.id,
    appointmentAt: now.toISOString(),
    channel: "whatsapp",
    language,
    address,
    optIn: { method: "judge_demo_keyword", at: event.serverAt },
    demo: true,
  });
  log("demo_dispatched", { loadId, language, dispatchError: out.dispatchError, superseded: out.superseded });
}
