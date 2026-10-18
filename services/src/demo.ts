import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { JUDGE_DEMO_CLAUSE } from "@dockclock/clause-engine";
import { JUDGE_DEMO_FACILITY } from "@dockclock/evidence";
import type { InboundEvent } from "@dockclock/whatsapp";
import { handler as dispatch } from "./dispatch.js";
import { driverKey, replyAddress } from "./identity.js";
import type { Language } from "./messages.js";
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
const PER_SENDER_PER_DAY = 5;
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

const INTRO: Record<Language, string> = {
  en_US: `DockClock demo, about 10 minutes. You are the truck driver and the dispatcher. 1) Tap Arrived and share your location (any location counts in the demo). 2) Free time is ${MINUTES} minutes: wait longer than that, then tap Released and share your location again. 3) Write the two times on a piece of paper, photograph it in the form and keep the times it suggests. 4) Approve the claim. The claim email goes to a fictional receiver whose mail lands in our test mailbox, never to you; we tell you here what was sent. Send DEMO again to start over (${PER_SENDER_PER_DAY} a day per number, reset at 00:00 UTC). Your pins and photo are kept as signed evidence for 30 days.`,
  es_MX: `Demo de DockClock, unos 10 minutos. Usted es el chofer y el despachador. 1) Toque Llegué y comparta su ubicación (cualquier lugar vale en la demo). 2) El tiempo libre es de ${MINUTES} minutos: espere más, toque Liberado y comparta su ubicación otra vez. 3) Escriba las dos horas en un papel, fotografíelo en el formulario y deje las horas que sugiere. 4) Apruebe el reclamo. El correo va a un receptor ficticio cuyo correo llega a nuestro buzón de prueba, nunca a usted; aquí le decimos qué se envió. Envíe DEMO otra vez para empezar de nuevo (${PER_SENDER_PER_DAY} al día por número, se reinicia a las 00:00 UTC). Sus ubicaciones y su foto se guardan como evidencia firmada por 30 días.`,
  fr_CA: `Démo DockClock, environ 10 minutes. Vous êtes le chauffeur et le répartiteur. 1) Touchez Arrivé et partagez votre position (n'importe où compte pour la démo). 2) Le temps alloué est de ${MINUTES} minutes : attendez plus longtemps, touchez Libéré et partagez votre position de nouveau. 3) Écrivez les deux heures sur un papier, photographiez-le dans le formulaire et gardez les heures proposées. 4) Approuvez la réclamation. Le courriel va à un destinataire fictif dont le courrier arrive dans notre boîte de test, jamais à vous; nous vous disons ici ce qui a été envoyé. Envoyez DEMO de nouveau pour recommencer (${PER_SENDER_PER_DAY} par jour par numéro, remis à zéro à 00 h 00 UTC). Vos positions et votre photo sont conservées comme preuve signée pendant 30 jours.`,
};

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
    await send(target, textMessage("The DockClock demo has reached today's limit. Please try again tomorrow."), "demo_limit", "-");
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
