// The landing hero's story, built only from one load's recorded read-API responses
// (site/fixtures/api/loads/<id>.json and its emails). Nothing here is written by hand: each chapter
// picks records by purpose, so swapping HERO_LOAD swaps every message, time and email.
import type * as Api from "../api.js";
import { detailFromApi } from "../model/fromApi.js";
import type { ConsoleEmail, ConsoleMessage, LoadDetail } from "../model/model.js";
import type { ClockEndedBy } from "../copy/provenance.js";
import { FEATURED } from "../featured.js";
import { fixtureFor, fixturePhotoUrl } from "../model/fixtures.js";

export const HERO_LOAD = FEATURED.whatsapp;

// The recorded response's data at an API path, or null when there is no such file.
function recorded<T>(path: string): T | null {
  try {
    return ((fixtureFor(path) as { data?: T }).data ?? null) as T | null;
  } catch {
    return null;
  }
}

export type Screen =
  | { kind: "phone"; party: "driver" | "dispatcher" }
  | { kind: "mail"; email: ConsoleEmail; body: string | null };

// One beat shows one record. A beat with `tap` first presses that button on the bubble above it.
export interface Beat {
  message?: ConsoleMessage;
  tap?: { messageId: string; title: string };
}

export interface Chapter {
  key: "dispatched" | "arrived" | "notice" | "released" | "approved" | "filed";
  label: string;
  at: string;
  caption: string;
  screen: Screen;
  beats: Beat[];
}

export interface Story {
  load: LoadDetail;
  chapters: Chapter[];
  // The whole recorded thread per phone, for the static storyboard.
  thread: { driver: ConsoleMessage[]; dispatcher: ConsoleMessage[] };
  // The bill-of-lading photo, shown only when the agent's tool could read it.
  bolPhoto: string | null;
  // What stopped the clock: the Released tap, the release pin, or nothing yet.
  endedBy: ClockEndedBy;
}

function beatsFor(messages: ConsoleMessage[], all: ConsoleMessage[]): Beat[] {
  return messages.map((m) => {
    if (m.direction === "in" && m.kind === "buttons" && m.buttons?.[0]) {
      // a tapped quick reply: press the button on the latest earlier bubble that offered it
      const title = m.buttons[0].title;
      const offer = [...all].reverse().find((o) => o.direction === "out" && Date.parse(o.at) < Date.parse(m.at) && o.buttons?.some((b) => b.title === title));
      return offer ? { message: m, tap: { messageId: offer.id, title } } : { message: m };
    }
    return { message: m };
  });
}

// Chapters a load does not have are left out: a load released inside free time has no notice, one
// held for a person has no approval or claim. Only the dispatch and the arrival are required.
export function buildStory(view: Api.LoadView, bodies: Partial<Record<"notice" | "claim", string>>, resolveUrl: (u: string) => string = (u) => u): Story | null {
  const load = detailFromApi(view, "fixture", resolveUrl);
  const msgs = [...load.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const driver = msgs.filter((m) => m.party === "driver");
  const dispatcher = msgs.filter((m) => m.party === "dispatcher");
  const notice = load.emails.find((e) => e.purpose === "notice" && e.status !== "not_sent");
  const claim = load.emails.find((e) => e.purpose === "claim" && e.status !== "not_sent");
  const arrivedPin = driver.find((m) => m.kind === "location");
  const pins = driver.filter((m) => m.kind === "location");
  const releasedPin = pins.length > 1 ? pins.at(-1)! : null;
  const releasedTap = [...driver].reverse().find((m) => m.purpose === "tap_released");
  const approvalAsk = dispatcher.find((m) => m.purpose === "dispatch_approval");
  const first = driver[0];
  if (!first || !arrivedPin) return null;

  const t = (iso: string) => Date.parse(iso);
  // The arrival chapter runs to the notice; without one, to the Released tap or the release pin.
  const arrivedEnd = notice?.sentAt ?? releasedTap?.at ?? releasedPin?.at ?? arrivedPin.at;
  const ch2 = driver.filter((m) => t(m.at) > t(first.at) && (t(m.at) < t(arrivedEnd) || (!notice && t(m.at) <= t(arrivedEnd) && m !== releasedTap)));
  const releaseEnd = claim?.sentAt ?? approvalAsk?.at ?? driver.at(-1)!.at;
  const ch4 = driver.filter((m) => !ch2.includes(m) && m !== first && t(m.at) <= t(releaseEnd));
  // The clock stops where the record says it did: the Released tap on newer loads, the pin on older ones.
  const releasedAt = load.clock.releasedAt ?? releasedTap?.at ?? releasedPin?.at ?? null;
  const endedBy: ClockEndedBy = !releasedAt ? null : releasedTap && t(releasedTap.at) === t(releasedAt) ? "released_tap" : "released_pin";

  const chapters: Chapter[] = [
    { key: "dispatched", label: "Dispatched", at: first.at, caption: "The load lands on the driver's WhatsApp.", screen: { kind: "phone", party: "driver" }, beats: beatsFor([first], msgs) },
    { key: "arrived", label: "Arrived", at: arrivedPin.at, caption: "A tap and a location pin start the dock clock.", screen: { kind: "phone", party: "driver" }, beats: beatsFor(ch2, msgs) },
  ];
  if (notice) chapters.push({ key: "notice", label: "Notice", at: notice.sentAt, caption: "The receiver gets notice before free time ends.", screen: { kind: "mail", email: notice, body: bodies.notice ?? null }, beats: [{}] });
  if (releasedAt && ch4.length > 0)
    chapters.push({ key: "released", label: "Released", at: releasedAt, caption: endedBy === "released_tap" ? "The Released tap stops the clock. A pin and the signed bill of lading back it up." : "A second pin stops the clock. The bill of lading comes from the camera.", screen: { kind: "phone", party: "driver" }, beats: beatsFor(ch4, msgs) });
  if (approvalAsk) {
    const beats: Beat[] = [{ message: approvalAsk }];
    if (load.approval?.decision === "approve") beats.push({ tap: { messageId: approvalAsk.id, title: approvalAsk.buttons?.[0]?.title ?? "Approve claim" } });
    for (const m of dispatcher.filter((m) => m !== approvalAsk && (!claim || t(m.at) <= t(claim.sentAt)))) beats.push({ message: m });
    chapters.push({ key: "approved", label: load.approval?.decision === "approve" ? "Approved" : "Dispatch", at: load.approval?.decidedAt ?? approvalAsk.at, caption: "Dispatch approves the claim from WhatsApp.", screen: { kind: "phone", party: "dispatcher" }, beats });
  }
  if (claim) chapters.push({ key: "filed", label: "Filed", at: claim.sentAt, caption: "The agent emails the claim with the signed evidence.", screen: { kind: "mail", email: claim, body: bodies.claim ?? null }, beats: [{}] });
  const bolPhoto = load.photos.find((p) => p.legible === true && p.url)?.url ?? null;
  return { load, chapters, thread: { driver, dispatcher }, bolPhoto, endedBy };
}

export function heroStory(): Story | null {
  const view = recorded<Api.LoadView>(`/api/loads/${HERO_LOAD}`);
  if (!view) return null;
  const notice = recorded<{ body?: string }>(`/api/loads/${HERO_LOAD}/emails/notice`);
  const claim = recorded<{ body?: string }>(`/api/loads/${HERO_LOAD}/emails/claim`);
  return buildStory(view, { ...(notice?.body ? { notice: notice.body } : {}), ...(claim?.body ? { claim: claim.body } : {}) }, fixturePhotoUrl);
}
