import { useEffect, useRef, useState } from "react";
import { clock, usd } from "../format.js";
import { useMedia } from "./media.js";
import type { Story } from "./story.js";

// "The wait": a pinned scroll scene. The truck backs onto Door 05 while the dock clock runs from the
// arrival pin to the release pin, the track fills (free time dashed, billable time striped), and the
// contract's stamp lands. Every number comes from the recorded load. Under reduced motion it is
// drawn once, at its last frame, and does not pin.

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => 1 - Math.pow(1 - x, 3);

function useScrollProgress(reduced: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [p, setP] = useState(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) {
      setP(1);
      return;
    }
    let raf = 0;
    const read = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const run = r.height - window.innerHeight;
      setP(run > 0 ? clamp(-r.top / run) : 1);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [reduced]);
  return [ref, p] as const;
}


function hms(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");
}

export function WaitScene({ story, reduced }: { story: Story; reduced: boolean }) {
  const [ref, p] = useScrollProgress(reduced);
  const narrow = useMedia("(max-width: 640px)", false);
  const { load } = story;
  const tz = load.timeZone;
  const arrived = load.clock.arrivedAt!;
  const released = load.clock.releasedAt!;
  const freeEnds = load.clock.freeTimeEndsAt!;
  const stay = (Date.parse(released) - Date.parse(arrived)) / 1000;
  const free = (Date.parse(freeEnds) - Date.parse(arrived)) / 1000;
  const freeShare = free / stay;
  const amount = load.verdict?.amountUsd ?? load.summary.amountUsd ?? 0;
  const owed = load.verdict?.verdict === "BILLABLE";
  const filed = story.chapters.find((c) => c.key === "filed")?.at ?? null;
  const freeMin = Math.round(free / 60);
  const billMin = Math.floor((load.clock.billableMinutes ?? 0));

  // phases of the scroll: drive in, the clock runs, the stamp lands
  const drive = ease(clamp(p / 0.2));
  const run = clamp((p - 0.22) / 0.58);
  const stamp = clamp((p - 0.84) / 0.1);
  const elapsed = run * stay;
  const billing = elapsed > free;

  return (
    <section className={`lp-wait ${reduced ? "still" : ""}`} ref={ref} aria-labelledby="wait-h" id="wait">
      <div className="lp-wait-pin">
        <div className="lp-wait-inner">
          <div className="lp-wait-copy">
            <p className="lp-kicker dark">The wait</p>
            <h2 id="wait-h" className="lp-h2">{Math.round(stay / 60)} minutes at the door. {freeMin} were free. The rest were owed.</h2>
            <p className="lp-wait-sub">Demo contract: {freeMin} minutes free, ${load.clause?.ratePerHourUsd ?? 60} an hour. The clock runs on WhatsApp's own timestamps.</p>
          </div>

          <div className="lp-led" aria-label={`At the dock ${hms(stay)}`}>
            <span className="lbl">At the dock</span>
            <span className={`digits ${billing ? "bill" : ""}`} aria-hidden="true">{hms(elapsed)}</span>
          </div>

          <svg className="lp-yard" viewBox={narrow ? "270 30 730 270" : "0 34 1000 266"} role="img" aria-label="A truck backed onto dock door 05">
            {/* dock wall and door 05 */}
            <rect x="770" y="30" width="230" height="218" fill="#2a2d33" />
            <rect x="808" y="42" width="64" height="40" rx="3" fill="#121316" stroke="#ffc400" strokeWidth="4" />
            <text x="840" y="73" textAnchor="middle" className="lp-door-no">05</text>
            <rect x="786" y="92" width="168" height="8" fill="#454b57" />
            <rect x="790" y="100" width="160" height="140" fill="#eef0ee" />
            {Array.from({ length: 9 }, (_, i) => <line key={i} x1="790" x2="950" y1={112 + i * 14} y2={112 + i * 14} stroke="#c3c8cf" strokeWidth="2" />)}
            <rect x="780" y="222" width="12" height="26" rx="2" fill="#ffc400" />
            <rect x="948" y="222" width="12" height="26" rx="2" fill="#ffc400" />
            {/* road */}
            <rect x="0" y="248" width="1000" height="52" fill="#1c1e22" />
            <line x1="0" x2="1000" y1="274" y2="274" stroke="#5e6573" strokeWidth="3" strokeDasharray="26 22" />
            {/* the truck: a day cab on the left, a dry van reversing onto the door */}
            <g transform={`translate(${-560 + drive * 568} 0)`}>
              {/* trailer body, rails, ribs, rear doors */}
              <rect x="424" y="104" width="352" height="120" fill="#ffffff" />
              <rect x="424" y="104" width="352" height="7" fill="#c3c8cf" />
              <rect x="424" y="216" width="352" height="8" fill="#c3c8cf" />
              {Array.from({ length: 9 }, (_, i) => <line key={i} x1={460 + i * 30} x2={460 + i * 30} y1="111" y2="216" stroke="#e1e4e1" strokeWidth="2" />)}
              <rect x="736" y="111" width="40" height="105" fill="#f6f7f6" />
              <line x1="756" x2="756" y1="111" y2="216" stroke="#c3c8cf" strokeWidth="2" />
              <line x1="746" x2="746" y1="122" y2="206" stroke="#8b919c" strokeWidth="2" />
              <line x1="766" x2="766" y1="122" y2="206" stroke="#8b919c" strokeWidth="2" />
              <rect x="430" y="111" width="270" height="78" fill="#ffffff" />
              <text x="565" y="160" textAnchor="middle" className="lp-trailer-name">DEMO CARRIER</text>
              <text x="565" y="181" textAnchor="middle" className="lp-trailer-sub">fictional</text>
              {/* chassis, landing gear, rear bumper */}
              <rect x="560" y="224" width="200" height="8" fill="#454b57" />
              <rect x="520" y="224" width="6" height="22" fill="#454b57" />
              <rect x="512" y="244" width="22" height="4" fill="#454b57" />
              <rect x="768" y="224" width="10" height="16" fill="#454b57" />
              {/* tractor: frame, fuel tank, cab, hood, window, door, stack, mirror */}
              <rect x="292" y="214" width="150" height="10" fill="#454b57" />
              <rect x="402" y="208" width="38" height="8" rx="2" fill="#2a2d33" />
              <rect x="360" y="206" width="42" height="18" rx="9" fill="#8b919c" />
              <path d="M292 214 V176 Q292 168 300 167 L326 165 V122 Q326 112 336 111 L382 108 Q392 108 394 118 V214 Z" fill="#d5d9de" />
              <path d="M338 122 H384 V156 H338 Z" fill="#15171c" />
              <line x1="336" x2="336" y1="122" y2="206" stroke="#8b919c" strokeWidth="2" />
              <line x1="386" x2="386" y1="162" y2="206" stroke="#8b919c" strokeWidth="2" />
              <rect x="344" y="168" width="14" height="3" rx="1.5" fill="#8b919c" />
              <rect x="298" y="180" width="26" height="4" fill="#c3c8cf" />
              <rect x="298" y="188" width="26" height="4" fill="#c3c8cf" />
              <rect x="400" y="70" width="7" height="140" rx="3" fill="#8b919c" />
              <rect x="318" y="126" width="4" height="28" fill="#454b57" />
              <rect x="286" y="206" width="12" height="18" rx="2" fill="#2a2d33" />
              {[332, 470, 506, 700, 736].map((cx) => (
                <g key={cx}>
                  <circle cx={cx} cy="236" r="18" fill="#0b0c0e" />
                  <circle cx={cx} cy="236" r="9" fill="#8b919c" />
                  <circle cx={cx} cy="236" r="3.5" fill="#454b57" />
                </g>
              ))}
            </g>
          </svg>

          <div className="lp-wtrack" aria-hidden="true">
            <div className="bar">
              <i className="free" style={{ width: `${Math.min(run, freeShare) * 100}%` }} />
              <i className="bill" style={{ left: `${freeShare * 100}%`, width: `${Math.max(0, run - freeShare) * 100}%` }} />
              <span className="mark" style={{ left: `${freeShare * 100}%` }} />
            </div>
            <div className="ticks">
              <span style={{ left: 0 }}>Arrived {clock(arrived, tz)}</span>
              <span style={{ left: `${freeShare * 100}%` }}>{narrow ? "Free ends" : "Free time ends"} {clock(freeEnds, tz)}</span>
              <span style={{ left: "100%" }}>Released {clock(released, tz)}</span>
            </div>
          </div>

          <div className="lp-verdict" style={{ opacity: stamp, transform: `scale(${1.25 - 0.25 * stamp})` }}>
            <span className={`stamp lg ${owed ? "" : "red"}`}>{owed ? "Owed" : "Not owed"}</span>
            <span className="amt">{usd(amount)}</span>
            <span className="why">{billMin} billable minutes{filed ? `, claim filed ${clock(filed, tz)}` : ""}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
