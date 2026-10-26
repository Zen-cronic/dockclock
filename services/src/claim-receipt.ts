import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { sha256Hex } from "@dockclock/evidence";
import { loadPageUrl } from "@dockclock/mail";
import { driverKey } from "./identity.js";
import type { Language } from "./messages.js";
import { NOT_SENT, type Audience, type SentMessage } from "./outbound.js";
import { rcsText } from "./rcs.js";
import { recordBlocked, SendNotStarted, sendDocument, sendRcs, uploadMedia, type SendProgress, type Target } from "./sender.js";
import { ddb, type LoadItem } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

// After the claim is filed, the one-page PDF claim summary goes back over WhatsApp as a document
// message: to the dispatcher who approved it on a carrier load (their 24-hour window opened with the
// Approve tap seconds earlier), to the judge on a DEMO load (driver and dispatcher at once), and to a
// carrier load's driver too while their own window is still open. An RCS driver gets a short text
// with the amount and a link to the load's console page instead of a file. Every send passes the
// gates in sender.ts. Nothing here may fail the load: each recipient is tried on its own, and a
// failure is logged. The file is uploaded to WhatsApp once and its media id reused for every
// recipient.
//
// Each recipient is reserved on the CLAIM record before anything is sent, so a retried outcome step
// (its text failed after the PDF went) never sends the PDF twice. How far the send got decides
// what happens to the reservation and to the conversation's record of it:
// - A final answer keeps the reservation and records one not-sent row: a gate (replies off, a test
//   number, STOP), no PDF stored, a closed window, a test load, settings or addresses no retry can
//   fix (SendNotStarted with permanent set: RCS not configured, a driver RCS cannot reach, a phone
//   number that does not parse, no DISPATCHER_PHONE), and a WhatsApp send the provider refused
//   outright (sender.ts refusedOutright: an access-denied or validation answer on the first try;
//   nothing went). A retry finds the recipient handled.
// - A passing failure before the send call (the PDF cannot be read from S3, the upload to WhatsApp
//   fails, a table read throws) records a not-sent row and releases the reservation, so a retry can
//   still send. The released reservation remembers that row, and the retry deletes it, so the
//   conversation keeps one row per recipient: the latest attempt's.
// - Once the send call has started, any other failure may have sent the message (a timeout after
//   delivery, a throttle or 5xx after a retried attempt): the reservation stays and nothing is
//   recorded as not sent (SEND_UNCONFIRMED), on either channel.
// - After the provider accepted it (a receipt row failed to write) it was sent.

export const RECEIPT_PURPOSE = "claim_receipt";

const s3 = new S3Client({ maxAttempts: 3 });

// WhatsApp's customer-service window is 24 hours from the person's last message. A small margin
// keeps a send from racing the window's close.
const WINDOW_MS = 24 * 60 * 60 * 1000;
const WINDOW_MARGIN_MS = 10 * 60 * 1000;

interface ReceiptCopy {
  caption: (id: string, usd: string) => string;
  rcsLink: (id: string, usd: string, link: string) => string;
}

// Short and plain: what the file is, the amount, and where the signed pack went.
export const RECEIPT_TEXT: Record<Language, ReceiptCopy> = {
  en_US: {
    caption: (id, usd) => `Claim summary for load ${id}: ${usd}. The signed evidence pack went with the claim email.`,
    rcsLink: (id, usd, link) => `Claim summary for load ${id}: ${usd}. See the claim and its evidence: ${link}`,
  },
  es_MX: {
    caption: (id, usd) => `Resumen del reclamo de la carga ${id}: ${usd}. El paquete de evidencia firmado va con el correo del reclamo.`,
    rcsLink: (id, usd, link) => `Resumen del reclamo de la carga ${id}: ${usd}. Vea el reclamo y su evidencia: ${link}`,
  },
  fr_CA: {
    caption: (id, usd) => `Résumé de la réclamation du chargement ${id} : ${usd}. Le dossier de preuve signé est joint au courriel de réclamation.`,
    rcsLink: (id, usd, link) => `Résumé de la réclamation du chargement ${id} : ${usd}. Voir la réclamation et sa preuve : ${link}`,
  },
};

const usd = (n: number) => `$${n.toFixed(2)}`;

interface ClaimItem {
  status?: string;
  amountUsd?: number;
  pdfKey?: string;
  pdfName?: string;
  // The PDF's SHA-256, recorded when the claim was filed (claims filed before it was kept have none).
  pdfSha256?: string;
}

// Why a recipient got nothing on this run: an earlier run of the step already handled them.
export const ALREADY_HANDLED = "already handled by an earlier run of this step";

// The send call itself failed, so the message may or may not have gone. It is not sent again.
export const SEND_UNCONFIRMED = "the send call failed and the message may have gone; not sent again";

export interface ReceiptResult {
  audience: Audience;
  channel: "whatsapp" | "rcs";
  sent: boolean;
  // Why nothing went out, when nothing did (a gate, a closed window, a failure).
  skipped?: string;
}

// The last time the driver wrote on WhatsApp for this load: their latest inbound WhatsApp event.
// Approve and Hold taps are not load events, and failovers are DockClock's own records.
export async function lastDriverWhatsAppAt(loadId: string): Promise<string | null> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: env.table(),
      KeyConditionExpression: "pk = :p AND begins_with(sk, :e)",
      ExpressionAttributeValues: { ":p": keys.load(loadId).pk, ":e": "EVENT#" },
      ScanIndexForward: false,
    }),
  );
  const latest = (out.Items ?? []).find((e) => e.type !== "failover" && (e.channel ?? "whatsapp") === "whatsapp" && typeof e.serverAt === "string");
  return (latest?.serverAt as string | undefined) ?? null;
}

export function windowOpen(lastAt: string | null, now = Date.now()): boolean {
  if (!lastAt) return false;
  const at = Date.parse(lastAt);
  return Number.isFinite(at) && now - at < WINDOW_MS - WINDOW_MARGIN_MS;
}

// A missing or unparseable DISPATCHER_PHONE is a setting no retry can fix.
async function dispatcherTarget(): Promise<Target> {
  let e164 = "";
  try {
    e164 = env.dispatcherPhone();
  } catch {
    // missing: handled below
  }
  if (!e164) throw new SendNotStarted("DISPATCHER_PHONE is missing or not a phone number", NOT_SENT.noDispatcher, true);
  const address = { kind: "phone" as const, e164 };
  return { address, driverKey: await driverKey(address) };
}

// The PDF's SHA-256 (the same hash the console shows for the claim email's attachment): the one
// recorded at filing, else the stored bytes read once. WhatsApp reads the object itself through
// PostWhatsAppMessageMedia.
async function pdfHash(claim: ClaimItem, key: string): Promise<string> {
  if (claim.pdfSha256 && /^[0-9a-f]{64}$/.test(claim.pdfSha256)) return claim.pdfSha256;
  const object = await s3.send(new GetObjectCommand({ Bucket: env.bucket(), Key: key }));
  return sha256Hex(await object.Body!.transformToByteArray());
}

const RESERVATION: Record<Audience, string> = { dispatcher: "receiptDispatcherAt", driver: "receiptDriverAt" };
// The sort key of the not-sent row a released reservation left behind, for the retry to delete.
const LEFT_ROW: Record<Audience, string> = { dispatcher: "receiptDispatcherNotSentSk", driver: "receiptDriverNotSentSk" };

// Takes this recipient's one claim receipt, writing `at`. False when an earlier run already took it.
// A not-sent row left by an earlier run that released the reservation is deleted (best effort):
// this run records its own outcome.
async function reserve(loadId: string, audience: Audience, at: string): Promise<boolean> {
  let left: unknown;
  try {
    const out = await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.claim(loadId),
        UpdateExpression: "SET #r = :t REMOVE #n",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(#r)",
        ExpressionAttributeNames: { "#r": RESERVATION[audience], "#n": LEFT_ROW[audience] },
        ExpressionAttributeValues: { ":t": at },
        ReturnValues: "ALL_OLD",
      }),
    );
    left = out?.Attributes?.[LEFT_ROW[audience]];
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
  if (typeof left === "string" && left.startsWith("SEND#")) {
    try {
      await ddb.send(new DeleteCommand({ TableName: env.table(), Key: { pk: keys.load(loadId).pk, sk: left } }));
    } catch (error) {
      log("claim_receipt_row_delete_failed", { loadId, audience, error: (error as Error).name });
    }
  }
  return true;
}

// Gives back a reservation this run took, when nothing was sent, so a retry can send, and notes the
// not-sent row this run left (deleted by the retry). Only the value this run wrote is removed. Best
// effort: a release that fails leaves the recipient handled.
async function release(loadId: string, audience: Audience, at: string, row: { sk: string } | null): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.claim(loadId),
        UpdateExpression: row ? "REMOVE #r SET #n = :n" : "REMOVE #r",
        ConditionExpression: "#r = :t",
        ExpressionAttributeNames: { "#r": RESERVATION[audience], ...(row ? { "#n": LEFT_ROW[audience] } : {}) },
        ExpressionAttributeValues: { ":t": at, ...(row ? { ":n": row.sk } : {}) },
      }),
    );
  } catch (error) {
    log("claim_receipt_release_failed", { loadId, audience, error: (error as Error).name });
  }
}

export async function sendClaimReceipts(load: LoadItem): Promise<ReceiptResult[]> {
  const claim = (await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.claim(load.loadId), ConsistentRead: true }))).Item as ClaimItem | undefined;
  if (claim?.status !== "sent") {
    log("claim_receipt_skipped", { loadId: load.loadId, reason: "claim not recorded as sent" });
    return [];
  }
  const amount = usd(Number(claim.amountUsd ?? 0));
  const filename = claim.pdfName ?? `detention-claim-${load.loadId}.pdf`;
  const driver: Target = { address: load.address, driverKey: load.driverKey };
  const results: ReceiptResult[] = [];

  // The file's hash, read once for every WhatsApp recipient and kept only once read. No stored PDF is
  // a final answer for each recipient; a read that fails is a passing failure, tried again for the
  // next recipient (and on a retry). The RCS link needs no file.
  const pdfKey = claim.pdfKey;
  let sha256: string | undefined;
  const hash = async (key: string): Promise<string> => {
    if (sha256) return sha256;
    try {
      sha256 = await pdfHash(claim, key);
      return sha256;
    } catch (error) {
      log("claim_receipt_pdf_unreadable", { loadId: load.loadId, error: (error as Error).name });
      throw new SendNotStarted("the claim PDF could not be read", NOT_SENT.pdfUnreadable, false);
    }
  };
  if (pdfKey) await hash(pdfKey).catch(() => undefined);

  // One upload for every WhatsApp recipient. Only a media id is kept: a failed upload is tried again
  // for the next recipient.
  let mediaId: string | undefined;
  const upload = async () => {
    mediaId ??= claim.pdfKey ? await uploadMedia(env.bucket(), claim.pdfKey, RECEIPT_PURPOSE, load.loadId) : undefined;
    return mediaId;
  };

  const documentShown = (language: Language): SentMessage => ({ kind: "document", text: RECEIPT_TEXT[language].caption(load.loadId, amount), document: { filename, ...(sha256 ? { sha256 } : {}) } });

  const document = async (target: Target, language: Language, audience: Audience, progress: SendProgress): Promise<ReceiptResult> => {
    const caption = RECEIPT_TEXT[language].caption(load.loadId, amount);
    if (!pdfKey) {
      await recordBlocked(load.loadId, RECEIPT_PURPOSE, "whatsapp", { kind: "document", text: caption, document: { filename } }, audience, NOT_SENT.noPdf);
      return { audience, channel: "whatsapp", sent: false, skipped: NOT_SENT.noPdf };
    }
    const id = await sendDocument(target, { bucket: env.bucket(), key: pdfKey, filename, caption, sha256: await hash(pdfKey), upload }, RECEIPT_PURPOSE, load.loadId, { audience, progress });
    return { audience, channel: "whatsapp", sent: id !== null };
  };

  const notSent = async (audience: Audience, language: Language, reason: string): Promise<ReceiptResult> => {
    await recordBlocked(load.loadId, RECEIPT_PURPOSE, "whatsapp", documentShown(language), audience, reason);
    return { audience, channel: "whatsapp", sent: false, skipped: reason };
  };

  // An RCS driver gets the amount and the console link, never a file. Only demo-workspace loads
  // have a console page; without one the filed message already said everything a link would add.
  const rcsLink = async (progress: SendProgress): Promise<ReceiptResult | null> => {
    const link = loadPageUrl(load.loadId, load.ws);
    if (!link) {
      log("claim_receipt_skipped", { loadId: load.loadId, reason: "RCS driver and no console page for this load" });
      return null;
    }
    const id = await sendRcs(driver, rcsText(RECEIPT_TEXT[load.language ?? "en_US"].rcsLink(load.loadId, amount, link)), RECEIPT_PURPOSE, load.loadId, { progress });
    return { audience: "driver", channel: "rcs", sent: id !== null };
  };

  const language = load.language ?? "en_US";

  // Reserve, then send. Where a throw came from decides what happens to the reservation and the
  // record (the rules are in this file's header).
  const attempt = async (audience: Audience, run: (progress: SendProgress) => Promise<ReceiptResult | null>) => {
    const rcs = load.channel === "rcs" && audience === "driver";
    const channel = rcs ? "rcs" : "whatsapp";
    const progress: SendProgress = { stage: "gates" };
    const at = new Date().toISOString();
    let reserved = false;
    try {
      if (!(await reserve(load.loadId, audience, at))) {
        log("claim_receipt_skipped", { loadId: load.loadId, audience, reason: ALREADY_HANDLED });
        results.push({ audience, channel, sent: false, skipped: ALREADY_HANDLED });
        return;
      }
      reserved = true;
      const result = await run(progress);
      if (result) results.push(result);
    } catch (error) {
      const name = (error as Error).name;
      if (progress.stage === "accepted") {
        log("claim_receipt_record_failed", { loadId: load.loadId, audience, error: name });
        results.push({ audience, channel, sent: true });
        return;
      }
      if (progress.stage === "sending") {
        log("claim_receipt_unconfirmed", { loadId: load.loadId, audience, error: name });
        results.push({ audience, channel, sent: false, skipped: SEND_UNCONFIRMED });
        return;
      }
      // Nothing went. A setting or address no retry can fix, or a refusal, keeps the reservation
      // (one row, and a retry finds the recipient handled); anything else gives it back for a retry.
      const stopped = error instanceof SendNotStarted ? error : null;
      const permanent = stopped?.permanent === true;
      log("claim_receipt_failed", { loadId: load.loadId, audience, error: name, permanent });
      const shown: SentMessage = rcs ? { kind: "text", text: RECEIPT_TEXT[language].caption(load.loadId, amount) } : documentShown(audience === "dispatcher" ? "en_US" : language);
      const row = await recordBlocked(load.loadId, RECEIPT_PURPOSE, channel, shown, audience, stopped?.reason ?? NOT_SENT.failed);
      if (reserved && !permanent) await release(load.loadId, audience, at, row);
      results.push({ audience, channel, sent: false, skipped: stopped?.reason ?? name });
    }
  };

  if (load.demo === true) {
    // The judge approved their own claim, so the judge is the one waiting for it.
    await attempt("driver", (progress) => (load.channel === "rcs" ? rcsLink(progress) : document(driver, language, "driver", progress)));
  } else {
    // The dispatcher reads the approval template in English (dockclock_dispatch_approval).
    await attempt("dispatcher", async (progress) => (load.synthetic && !load.askDispatcher ? notSent("dispatcher", "en_US", NOT_SENT.testLoad) : document(await dispatcherTarget(), "en_US", "dispatcher", progress)));
    await attempt("driver", async (progress) => {
      if (load.channel === "rcs") return rcsLink(progress);
      return windowOpen(await lastDriverWhatsAppAt(load.loadId)) ? document(driver, language, "driver", progress) : notSent("driver", language, NOT_SENT.windowClosed);
    });
  }
  log("claim_receipts", { loadId: load.loadId, results: results.map((r) => ({ audience: r.audience, channel: r.channel, sent: r.sent })) });
  return results;
}
