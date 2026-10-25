import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { clock, dateLong, zoneName } from "../format.js";
import type { ConsoleMessage } from "../model/model.js";
import { IconPause, IconPlay } from "../ui/icons.js";
import { Mail, Phone } from "./Devices.js";
import { acceptsAnyLocation, recordingWords } from "../copy/provenance.js";
import type { Chapter, Story } from "./story.js";
import { useMedia } from "./media.js";

// The hero player: the recorded load, one record at a time, on the device that received it.
// It plays once when it scrolls into view, holds on the last frame and offers a replay. Each
// chapter is a button that jumps there. Under reduced motion the page shows <Storyboard> instead.

type Step = { c: number; kind: "show" | "press" | "hold"; message?: ConsoleMessage; tap?: string; dur: number };

const SHOW = 1050;
const PRESS = 560;
const HOLD_MAIL = 4600;
const CHAPTER_END = 900;
const SWAP = 500;
const LOOP_HOLD = 3200;

function stepsOf(chapters: Chapter[]): Step[] {
  const out: Step[] = [];
  chapters.forEach((ch, c) => {
    const start = out.length;
    if (ch.screen.kind === "mail") out.push({ c, kind: "hold", dur: HOLD_MAIL });
    for (const b of ch.beats) {
      if (b.tap) out.push({ c, kind: "press", tap: `${b.tap.messageId}:${b.tap.title}`, dur: PRESS });
      if (b.message) out.push({ c, kind: "show", message: b.message, ...(b.tap ? { tap: `${b.tap.messageId}:${b.tap.title}` } : {}), dur: SHOW });
    }
    if (out.length === start) out.push({ c, kind: "hold", dur: HOLD_MAIL });
    out[start]!.dur += c > 0 ? SWAP : 0;
    out[out.length - 1]!.dur += CHAPTER_END;
  });
  return out;
}

function view(steps: Step[], pos: number) {
  const shown = new Set<string>();
  const tapped = new Set<string>();
  let pressing: string | null = null;
  for (let i = 0; i <= pos; i++) {
    const s = steps[i]!;
    if (s.message) shown.add(s.message.id);
    if (s.tap) {
      if (s.kind === "press" && i === pos) pressing = s.tap;
      else tapped.add(s.tap);
    }
  }
  return { shown, tapped, pressing, chapter: steps[pos]!.c };
}

// How many lines of an email body fit the stage, so a mail view never runs under the sill.
function useMailLines(area: RefObject<HTMLDivElement | null>, narrow: boolean): number {
  const [lines, setLines] = useState(narrow ? 10 : 14);
  useEffect(() => {
    const el = area.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => setLines(Math.max(4, Math.min(16, Math.floor((el.clientHeight - (narrow ? 310 : 232)) / 19))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [area, narrow]);
  return lines;
}

const SCREEN_LABEL = { driver: "Driver's phone", dispatcher: "Dispatcher's phone", mail: "Receiver's inbox" } as const;

function screenKey(ch: Chapter): string {
  return ch.screen.kind === "mail" ? `mail-${ch.key}` : ch.screen.party;
}

export function HeroPlayer({ story }: { story: Story }) {
  const { chapters, load } = story;
  const tz = load.timeZone;
  const steps = useMemo(() => stepsOf(chapters), [chapters]);
  const firstOf = useMemo(() => chapters.map((_, c) => steps.findIndex((s) => s.c === c)), [chapters, steps]);
  const narrow = useMedia("(max-width: 640px)", false);
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [inView, setInView] = useState(false);
  const [pageShown, setPageShown] = useState(true);
  const stage = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const lines = useMailLines(area, narrow);
  const last = pos === steps.length - 1;

  // Plays while the stage is on screen and the tab is visible. The first check is synchronous, so
  // a stage already in the first viewport starts on the first frame, not on a later scroll.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setInView(r.top < window.innerHeight && r.bottom > 0);
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(!!e?.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const on = () => setPageShown(document.visibilityState !== "hidden");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // One step at a time; after the last step it holds, then starts again from the top.
  useEffect(() => {
    if (!playing || !inView || !pageShown) return;
    const t = setTimeout(() => setPos(last ? 0 : pos + 1), steps[pos]!.dur + (last ? LOOP_HOLD : 0));
    return () => clearTimeout(t);
  }, [playing, inView, pageShown, pos, last, steps]);

  const v = view(steps, pos);
  const ch = chapters[v.chapter]!;
  const active = screenKey(ch);
  const driverMsgs = story.thread.driver.filter((m) => v.shown.has(m.id));
  const dispatchMsgs = story.thread.dispatcher.filter((m) => v.shown.has(m.id));
  const lastShown = steps.slice(0, pos + 1).reverse().find((s) => s.message)?.message;
  const now = ch.screen.kind === "mail" ? ch.at : (lastShown?.at ?? ch.at);
  const any = acceptsAnyLocation(load);

  const seek = (c: number) => {
    setPos(firstOf[c]!);
    setPlaying(true);
  };
  const toggle = () => setPlaying(!playing);

  return (
    <div className="lp-player">
      <ol className="lp-chapters" aria-label="Steps">
        {chapters.map((c, i) => (
          <li key={c.key}>
            <button type="button" className={i === v.chapter ? "on" : i < v.chapter ? "past" : ""} aria-current={i === v.chapter ? "step" : undefined} onClick={() => seek(i)}>
              <span className="n">{String(i + 1).padStart(2, "0")}</span>
              <span className="l">{c.label}</span>
              <span className="t">{clock(c.at, tz)}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="lp-stagewrap" ref={stage}>
        <div className="lp-plate">
          <span className="lp-who" key={active}>{SCREEN_LABEL[ch.screen.kind === "mail" ? "mail" : ch.screen.party]}</span>
          <div className="lp-stage" id="lp-stage" ref={area}>
            <div className={`lp-dev ${active === "driver" ? "on" : ""}`} aria-hidden={active !== "driver"}>
              <Phone party="driver" messages={driverMsgs} timeZone={tz} pressing={v.pressing} tapped={v.tapped} anyLocation={any} bolPhoto={story.bolPhoto} />
            </div>
            <div className={`lp-dev ${active === "dispatcher" ? "on" : ""}`} aria-hidden={active !== "dispatcher"}>
              <Phone party="dispatcher" messages={dispatchMsgs} timeZone={tz} pressing={v.pressing} tapped={v.tapped} />
            </div>
            {chapters.filter((c) => c.screen.kind === "mail").map((c) =>
              c.screen.kind === "mail" ? (
                <div key={c.key} className={`lp-dev lp-dev-mail ${active === `mail-${c.key}` ? "on" : ""}`} aria-hidden={active !== `mail-${c.key}`}>
                  <Mail email={c.screen.email} body={c.screen.body} timeZone={tz} lines={lines} cols={narrow ? 44 : 62} />
                </div>
              ) : null,
            )}
          </div>
          <div className="lp-sill">
            <button type="button" className="lp-play" onClick={toggle} aria-controls="lp-stage">
              {playing ? <IconPause /> : <IconPlay />}
              <span>{playing ? "Pause" : "Play"}</span>
            </button>
            <div className="lp-track" style={{ gridTemplateColumns: `repeat(${chapters.length}, minmax(0, 1fr))` }}>
              {chapters.map((c, i) => {
                const start = firstOf[i]!;
                const count = (firstOf[i + 1] ?? steps.length) - start;
                const fill = i < v.chapter ? 1 : i > v.chapter ? 0 : (pos - start + 1) / count;
                return (
                  <button type="button" key={c.key} className="lp-seg" onClick={() => seek(i)} aria-label={`Step ${i + 1}: ${c.label}`}>
                    <i style={{ width: `${fill * 100}%`, transitionDuration: i === v.chapter && playing ? `${steps[pos]!.dur}ms` : "0ms" }} />
                  </button>
                );
              })}
            </div>
            <span className="lp-now">{clock(now, tz)} {zoneName(now, tz)}</span>
          </div>
        </div>
        <p className="lp-caption" key={ch.key}>
          <span className="n">{String(v.chapter + 1).padStart(2, "0")} {ch.label} <span className="role">∙ {SCREEN_LABEL[ch.screen.kind === "mail" ? "mail" : ch.screen.party]}</span></span>
          {ch.caption}
        </p>
        <Provenance story={story} />
      </div>
    </div>
  );
}

export function Provenance({ story }: { story: Story }) {
  const { load } = story;
  const first = story.thread.driver[0]?.at ?? load.summary.createdAt;
  const words = recordingWords(load);
  return (
    <p className="lp-prov">
      {words.source}, {dateLong(first, load.timeZone)} ∙ {words.times}, {zoneName(first, load.timeZone)} ∙ the companies are fictional
    </p>
  );
}


// Reduced motion, top of the page: the outcome (the filed claim in the receiver's inbox), still.
export function StaticHero({ story, onPlay }: { story: Story; onPlay: () => void }) {
  const filed = story.chapters.find((c) => c.screen.kind === "mail" && c.key === "filed") ?? story.chapters.at(-1)!;
  const narrow = useMedia("(max-width: 640px)", false);
  const area = useRef<HTMLDivElement>(null);
  const lines = useMailLines(area, narrow);
  return (
    <div className="lp-stagewrap">
      <div className="lp-plate">
        <span className="lp-who">{SCREEN_LABEL.mail}</span>
        <div className="lp-stage" ref={area}>
          <div className="lp-dev on">{filed.screen.kind === "mail" && <Mail email={filed.screen.email} body={filed.screen.body} timeZone={story.load.timeZone} lines={lines} cols={narrow ? 44 : 62} />}</div>
        </div>
        <div className="lp-sill">
          <button type="button" className="lp-play" onClick={onPlay}>
            <IconPlay />
            <span>Play the recording</span>
          </button>
          <span className="lp-now">Motion is reduced. Every step is below.</span>
        </div>
      </div>
      <p className="lp-caption">{filed.caption}</p>
    </div>
  );
}

// Reduced motion: every chapter at once, as a numbered storyboard.
export function Storyboard({ story }: { story: Story }) {
  const tz = story.load.timeZone;
  const any = acceptsAnyLocation(story.load);
  return (
    <div className="lp-board">
      <ol className="lp-board-list">
        {story.chapters.map((c, i) => {
          const msgs = c.beats.flatMap((b) => (b.message ? [b.message] : []));
          const tapped = new Set(c.beats.flatMap((b) => (b.tap ? [`${b.tap.messageId}:${b.tap.title}`] : [])));
          return (
            <li key={c.key} className="lp-frame">
              <div className="lp-frame-band">
                <p className="lp-frame-h">
                  <span className="n">{String(i + 1).padStart(2, "0")}</span>
                  <b>{c.label}</b>
                  <span className="t">{clock(c.at, tz)} {zoneName(c.at, tz)}</span>
                </p>
                <p className="lp-frame-c">{c.caption}</p>
              </div>
              <div className={`lp-frame-dev ${c.screen.kind === "mail" ? "mail" : ""}`}>
                {c.screen.kind === "mail" ? <Mail email={c.screen.email} body={c.screen.body} timeZone={tz} /> : <Phone party={c.screen.party} messages={msgs} timeZone={tz} tapped={tapped} anyLocation={any} bolPhoto={story.bolPhoto} scroll={false} />}
              </div>
            </li>
          );
        })}
      </ol>
      <Provenance story={story} />
    </div>
  );
}
