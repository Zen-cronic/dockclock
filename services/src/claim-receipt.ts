import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { sha256Hex } from "@dockclock/evidence";
import { loadPageUrl } from "@dockclock/mail";
import { driverKey } from "./identity.js";
import type { Language } from "./messages.js";
import { NOT_SENT, type Audience, type SentMessage } from "./outbound.js";
import { rcsText } from "./rcs.js";
import { addressValue, canonical, recordBlocked, SendNotStarted, sendDocument, sendRcs, uploadMedia, type SendProgress, type Target } from "./sender.js";
import { ddb, type Address, type LoadItem } from "./store.js";
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
// The dispatcher and a carrier load's WhatsApp driver can be one person (an owner-operator, or one
// phone set as DISPATCHER_PHONE and allowlisted as a driver). When both resolve to the same
// recipient (sameRecipient: the same kind of address with the same value once canonical, E.164 for
// a phone number; a BSUID never equals a phone number), that person gets one PDF: one send, recorded
// once as the dispatcher's, and the driver's result says it shared that send (sharedWith) instead of
// sending its own. The driver's 24-hour window is not checked then: the send is the dispatcher's,
// whose window the Approve tap opened. A test load that does not ask dispatch keeps the two apart,
// since only the driver's copy goes.
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
// - A passing failure before the send call (the PDF cannot be read from S3 for a recipient the gates
//   let through, the upload to WhatsApp fails, a table read throws) records a not-sent row and
//   releases the reservation, so a retry can still send. The released reservation remembers that
//   row. The retry deletes it only once its own not-sent row is written, or once its message went
//   (a not-sent row is then no longer true), so the conversation keeps one row per recipient: the
//   latest recorded attempt's. A retry that ends unconfirmed, stops part way, or fails to write its
//   own not-sent row leaves the earlier row in place.
// - Once the send call has started, any other failure may have sent the message (a timeout after
//   delivery, a throttle or 5xx after a retried attempt): the reservation stays and nothing is
//   recorded as not sent (SEND_UNCONFIRMED), on either channel.
// - After the provider accepted it (a receipt row failed to write) it was sent.
// A shared send reserves both roles in one write, and each rule above acts on the pair: both are
// kept, or both released; the one row (sent or not sent) is the dispatcher's, the CLAIM record notes
// the driver's share (receiptDriverSharedWith), and a retry finds both handled. When the pair cannot
// be reserved together (an earlier run, from before roles were shared, took only one of them), each
// role is tried on its own as before.

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
  // The role whose send this one shared: the dispatcher and the driver are one person, so one PDF
  // went for both (or one attempt, with this same outcome).
  sharedWith?: Audience;
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

// DISPATCHER_PHONE in E.164, or null when it is missing or does not parse.
function dispatcherE164(): string | null {
  try {
    return env.dispatcherPhone() || null;
  } catch {
    return null;
  }
}

// A missing or unparseable DISPATCHER_PHONE is a setting no retry can fix.
async function dispatcherTarget(): Promise<Target> {
  const e164 = dispatcherE164();
  if (!e164) throw new SendNotStarted("DISPATCHER_PHONE is missing or not a phone number", NOT_SENT.noDispatcher, true);
  const address = { kind: "phone" as const, e164 };
  return { address, driverKey: await driverKey(address) };
}

// Whether DISPATCHER_PHONE and the driver's address are one WhatsApp recipient (sameRecipient). A
// missing or unparseable setting is no one.
function dispatcherIsDriver(address: Address): boolean {
  const e164 = dispatcherE164();
  return e164 !== null && sameRecipient({ kind: "phone", e164 }, address);
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
// Set on a role whose receipt shared another role's send: the role it shared.
const SHARED_WITH: Record<Audience, string> = { dispatcher: "receiptDispatcherSharedWith", driver: "receiptDriverSharedWith" };

// Whether two addresses reach the same WhatsApp recipient, as far as DockClock can prove: the same
// kind with the same value once canonical. A BSUID and a phone number may be one person, but nothing
// here shows it, so they differ; an address that does not parse equals nothing.
export function sameRecipient(a: Address, b: Address): boolean {
  try {
    const x = canonical(a);
    const y = canonical(b);
    return x.kind === y.kind && addressValue(x) === addressValue(y);
  } catch {
    return false;
  }
}

// Expression names for a reservation over one or more roles: #r0/#n0 for the first, #r1/#n1 for a
// role sharing its send.
const names = (audiences: Audience[], table: Record<Audience, string>, prefix: string) => Object.fromEntries(audiences.map((a, i) => [`${prefix}${i}`, table[a]]));
const leftKey = (value: unknown): string | null => (typeof value === "string" && value.startsWith("SEND#") ? value : null);

// Takes the recipient's one claim receipt, writing `at`: for one role, or for the dispatcher and the
// driver together when they are one person (the later roles noted as sharing the first's send).
// Null when an earlier run already took any of them. Otherwise gives, per role, the key of the
// not-sent row an earlier run left when it released the reservation: that row stays until this run
// records its own outcome (dropLeftRow), so a run that ends unconfirmed or stops part way leaves the
// conversation with the earlier attempt's row.
async function reserve(loadId: string, audiences: Audience[], at: string): Promise<{ left: Array<string | null> } | null> {
  const [first, ...sharing] = audiences;
  const set = [...audiences.map((_, i) => `#r${i} = :t`), ...sharing.map((_, i) => `#s${i + 1} = :a`)];
  try {
    const out = await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.claim(loadId),
        UpdateExpression: `SET ${set.join(", ")} REMOVE ${audiences.map((_, i) => `#n${i}`).join(", ")}`,
        ConditionExpression: ["attribute_exists(pk)", ...audiences.map((_, i) => `attribute_not_exists(#r${i})`)].join(" AND "),
        ExpressionAttributeNames: {
          ...names(audiences, RESERVATION, "#r"),
          ...names(audiences, LEFT_ROW, "#n"),
          ...Object.fromEntries(sharing.map((a, i) => [`#s${i + 1}`, SHARED_WITH[a]])),
        },
        ExpressionAttributeValues: { ":t": at, ...(sharing.length ? { ":a": first } : {}) },
        // Only the attributes this update touched: the reservations, the shares and the left rows' keys.
        ReturnValues: "UPDATED_OLD",
      }),
    );
    return { left: audiences.map((a) => leftKey(out?.Attributes?.[LEFT_ROW[a]])) };
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") return null;
    throw error;
  }
}

// Deletes the not-sent row an earlier run left, once this run has recorded its own outcome (best
// effort), so the conversation keeps one row per recipient: the latest attempt's.
async function dropLeftRow(loadId: string, audience: Audience, left: string | null): Promise<void> {
  if (!left) return;
  try {
    await ddb.send(new DeleteCommand({ TableName: env.table(), Key: { pk: keys.load(loadId).pk, sk: left } }));
  } catch (error) {
    log("claim_receipt_row_delete_failed", { loadId, audience, error: (error as Error).name });
  }
}

// Gives back a reservation this run took (one role, or a shared pair together), when nothing was
// sent, so a retry can send, and notes per role the not-sent row left on the load (deleted by the
// retry once it records its own). Only the values this run wrote are removed. Best effort: a release
// that fails leaves the recipient handled.
async function release(loadId: string, audiences: Audience[], at: string, rows: Array<{ sk: string } | null>): Promise<void> {
  const sharing = audiences.slice(1);
  const noted = audiences.flatMap((a, i) => (rows[i] ? [i] : []));
  const remove = [...audiences.map((_, i) => `#r${i}`), ...sharing.map((_, i) => `#s${i + 1}`)];
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.claim(loadId),
        UpdateExpression: `REMOVE ${remove.join(", ")}${noted.length ? ` SET ${noted.map((i) => `#n${i} = :n${i}`).join(", ")}` : ""}`,
        ConditionExpression: audiences.map((_, i) => `#r${i} = :t`).join(" AND "),
        ExpressionAttributeNames: {
          ...names(audiences, RESERVATION, "#r"),
          ...Object.fromEntries(sharing.map((a, i) => [`#s${i + 1}`, SHARED_WITH[a]])),
          ...Object.fromEntries(noted.map((i) => [`#n${i}`, LEFT_ROW[audiences[i]!]])),
        },
        ExpressionAttributeValues: { ":t": at, ...Object.fromEntries(noted.map((i) => [`:n${i}`, rows[i]!.sk])) },
      }),
    );
  } catch (error) {
    log("claim_receipt_release_failed", { loadId, audience: audiences[0], error: (error as Error).name });
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
  // next recipient the gates let through (and on a retry). The RCS link needs no file.
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
      await recordBlocked(load.loadId, RECEIPT_PURPOSE, "whatsapp", { kind: "document", text: caption, document: { filename } }, audience, NOT_SENT.noPdf, progress);
      return { audience, channel: "whatsapp", sent: false, skipped: NOT_SENT.noPdf };
    }
    // The hash is read only for a recipient the gates let through (sendDocument): a failed read for
    // one they stop never replaces the gate's answer.
    const id = await sendDocument(target, { bucket: env.bucket(), key: pdfKey, filename, caption, sha256: sha256 ?? (() => hash(pdfKey)), upload }, RECEIPT_PURPOSE, load.loadId, { audience, progress });
    return { audience, channel: "whatsapp", sent: id !== null };
  };

  const notSent = async (progress: SendProgress, audience: Audience, language: Language, reason: string): Promise<ReceiptResult> => {
    await recordBlocked(load.loadId, RECEIPT_PURPOSE, "whatsapp", documentShown(language), audience, reason, progress);
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
  // record (the rules are in this file's header). `audiences` is the recipient's roles: one, or the
  // dispatcher and the driver when they are one person, sent once and recorded under the first, the
  // others' results marked as sharing it. False when such a pair could not be reserved together.
  const attempt = async (audiences: Audience[], run: (progress: SendProgress) => Promise<ReceiptResult | null>): Promise<boolean> => {
    const [audience, ...sharing] = audiences as [Audience, ...Audience[]];
    const rcs = load.channel === "rcs" && audience === "driver";
    const channel = rcs ? "rcs" : "whatsapp";
    const progress: SendProgress = { stage: "gates" };
    const at = new Date().toISOString();
    let reserved = false;
    let left: Array<string | null> = [];
    const push = (result: ReceiptResult) => {
      results.push(result);
      for (const other of sharing) results.push({ ...result, audience: other, sharedWith: audience });
    };
    const dropLeftRows = async () => {
      for (const [i, a] of audiences.entries()) await dropLeftRow(load.loadId, a, left[i] ?? null);
    };
    try {
      const taken = await reserve(load.loadId, audiences, at);
      if (!taken) {
        if (sharing.length) return false;
        log("claim_receipt_skipped", { loadId: load.loadId, audience, reason: ALREADY_HANDLED });
        results.push({ audience, channel, sent: false, skipped: ALREADY_HANDLED });
        return true;
      }
      reserved = true;
      left = taken.left;
      const result = await run(progress);
      // An answer replaces an earlier attempt's not-sent row once its own row is written (sent, or
      // not sent with the reason; both best effort). A message that went replaces it either way: a
      // not-sent row for it would no longer be true. A skipped RCS link (null) recorded nothing, and
      // a not-sent row that failed to write leaves the earlier one in place.
      if (result) {
        push(result);
        if (result.sent || progress.recorded) await dropLeftRows();
      }
    } catch (error) {
      const name = (error as Error).name;
      if (progress.stage === "accepted") {
        log("claim_receipt_record_failed", { loadId: load.loadId, audience, error: name });
        push({ audience, channel, sent: true });
        // It went, so an earlier attempt's not-sent row is no longer true.
        await dropLeftRows();
        return true;
      }
      if (progress.stage === "sending") {
        // Nothing is recorded for a send that may have gone, so an earlier attempt's row stays.
        log("claim_receipt_unconfirmed", { loadId: load.loadId, audience, error: name });
        push({ audience, channel, sent: false, skipped: SEND_UNCONFIRMED });
        return true;
      }
      // Nothing went. A setting or address no retry can fix, or a refusal, keeps the reservation
      // (one row, and a retry finds the recipient handled); anything else gives it back for a retry.
      const stopped = error instanceof SendNotStarted ? error : null;
      const permanent = stopped?.permanent === true;
      log("claim_receipt_failed", { loadId: load.loadId, audience, error: name, permanent });
      const shown: SentMessage = rcs ? { kind: "text", text: RECEIPT_TEXT[language].caption(load.loadId, amount) } : documentShown(audience === "dispatcher" ? "en_US" : language);
      const row = await recordBlocked(load.loadId, RECEIPT_PURPOSE, channel, shown, audience, stopped?.reason ?? NOT_SENT.failed);
      // This run's row (the first role's, for a shared pair) replaces every earlier one; when it could
      // not be written the earlier ones stay, and a released reservation remembers whichever are on
      // the load.
      if (row) await dropLeftRows();
      const kept = (i: number) => (left[i] ? { sk: left[i]! } : null);
      if (reserved && !permanent) await release(load.loadId, audiences, at, audiences.map((_, i) => (row ? (i === 0 ? row : null) : kept(i))));
      push({ audience, channel, sent: false, skipped: stopped?.reason ?? name });
    }
    return true;
  };

  if (load.demo === true) {
    // The judge approved their own claim, so the judge is the one waiting for it.
    await attempt(["driver"], (progress) => (load.channel === "rcs" ? rcsLink(progress) : document(driver, language, "driver", progress)));
  } else {
    // The dispatcher reads the approval template in English (dockclock_dispatch_approval).
    const testLoad = load.synthetic && !load.askDispatcher;
    const toDispatcher = async (progress: SendProgress) => (testLoad ? notSent(progress, "dispatcher", "en_US", NOT_SENT.testLoad) : document(await dispatcherTarget(), "en_US", "dispatcher", progress));
    const toDriver = async (progress: SendProgress) => {
      if (load.channel === "rcs") return rcsLink(progress);
      return windowOpen(await lastDriverWhatsAppAt(load.loadId)) ? document(driver, language, "driver", progress) : notSent(progress, "driver", language, NOT_SENT.windowClosed);
    };
    // One person in both roles gets the dispatcher's copy only (this file's header).
    const shared = !testLoad && load.channel !== "rcs" && dispatcherIsDriver(load.address);
    if (!shared || !(await attempt(["dispatcher", "driver"], toDispatcher))) {
      await attempt(["dispatcher"], toDispatcher);
      await attempt(["driver"], toDriver);
    }
  }
  log("claim_receipts", { loadId: load.loadId, results: results.map((r) => ({ audience: r.audience, channel: r.channel, sent: r.sent, ...(r.sharedWith ? { sharedWith: r.sharedWith } : {}) })) });
  return results;
}
