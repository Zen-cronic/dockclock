// The landing hero's story, built only from one load's recorded read-API responses
// (site/fixtures/api/loads/<id>.json and its emails). Nothing here is written by hand: each chapter
// picks records by purpose, so swapping HERO_LOAD swaps every message, time and email.
import type * as Api from "../api.js";
import { detailFromApi } from "../model/fromApi.js";
import type { ConsoleEmail, ConsoleMessage, LoadDetail } from "../model/model.js";
import { FEATURED } from "../featured.js";

export const HERO_LOAD = FEATURED.whatsapp;

type Fixture<T> = { data: T };
const files = import.meta.glob<Fixture<unknown>>("../../fixtures/api/loads/*.json", { eager: true, import: "default" });

function fixture<T>(name: string): T | null {
  const hit = Object.entries(files).find(([k]) => k.endsWith(`/loads/${name}.json`));
  return hit ? (hit[1].data as T) : null;
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

export function buildStory(view: Api.LoadView, bodies: Partial<Record<"notice" | "claim", string>>): Story | null {
  const load = detailFromApi(view, "fixture");
  const msgs = [...load.messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const driver = msgs.filter((m) => m.party === "driver");
  const dispatcher = msgs.filter((m) => m.party === "dispatcher");
  const notice = load.emails.find((e) => e.purpose === "notice");
  const claim = load.emails.find((e) => e.purpose === "claim");
  const arrivedPin = driver.find((m) => m.kind === "location");
  const releasedPin = [...driver].reverse().find((m) => m.kind === "location");
  const approvalAsk = dispatcher.find((m) => m.purpose === "dispatch_approval");
  if (!notice || !claim || !arrivedPin || !releasedPin || releasedPin === arrivedPin || !approvalAsk) return null;

  const before = (iso: string) => (m: ConsoleMessage) => Date.parse(m.at) <= Date.parse(iso);
  const between = (from: string, to: string) => (m: ConsoleMessage) => Date.parse(m.at) > Date.parse(from) && Date.parse(m.at) <= Date.parse(to);
  const first = driver[0]!;
  const end = (xs: ConsoleMessage[]) => xs.at(-1)?.at ?? first.at;

  const ch1 = driver.filter(before(first.at));
  // Arrived: everything after dispatch up to the notice email (the tap, the pin, the check-in)
  const ch2 = driver.filter(between(first.at, notice.sentAt));
  // Released: the rest of the driver's thread, from the notice text to the photo receipt
  const ch4 = driver.filter(between(notice.sentAt, claim.sentAt));
  const approvedAt = load.approval?.decidedAt ?? end(dispatcher);
  const approvalBeats: Beat[] = [{ message: approvalAsk }];
  if (load.approval?.decision === "approve") approvalBeats.push({ tap: { messageId: approvalAsk.id, title: approvalAsk.buttons?.[0]?.title ?? "Approve claim" } });
  for (const m of dispatcher.filter((m) => m !== approvalAsk && Date.parse(m.at) <= Date.parse(claim.sentAt))) approvalBeats.push({ message: m });

  const chapters: Chapter[] = [
    { key: "dispatched", label: "Dispatched", at: first.at, caption: "The load lands on the driver's WhatsApp.", screen: { kind: "phone", party: "driver" }, beats: beatsFor(ch1, msgs) },
    { key: "arrived", label: "Arrived", at: arrivedPin.at, caption: "A tap and a location pin start the dock clock.", screen: { kind: "phone", party: "driver" }, beats: beatsFor(ch2, msgs) },
    { key: "notice", label: "Notice", at: notice.sentAt, caption: "The receiver gets notice before free time ends.", screen: { kind: "mail", email: notice, body: bodies.notice ?? null }, beats: [{}] },
    { key: "released", label: "Released", at: releasedPin.at, caption: "A second pin stops the clock. The bill of lading comes from the camera.", screen: { kind: "phone", party: "driver" }, beats: beatsFor(ch4, msgs) },
    { key: "approved", label: "Approved", at: approvedAt, caption: "Dispatch approves the claim from WhatsApp.", screen: { kind: "phone", party: "dispatcher" }, beats: approvalBeats },
    { key: "filed", label: "Filed", at: claim.sentAt, caption: "The agent emails the claim with the signed evidence.", screen: { kind: "mail", email: claim, body: bodies.claim ?? null }, beats: [{}] },
  ];
  return { load, chapters, thread: { driver, dispatcher } };
}

export function heroStory(): Story | null {
  const view = fixture<Api.LoadView>(HERO_LOAD);
  if (!view) return null;
  const notice = fixture<{ body?: string }>(`${HERO_LOAD}.emails.notice`);
  const claim = fixture<{ body?: string }>(`${HERO_LOAD}.emails.claim`);
  return buildStory(view, { ...(notice?.body ? { notice: notice.body } : {}), ...(claim?.body ? { claim: claim.body } : {}) });
}
