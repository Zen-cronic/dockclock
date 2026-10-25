import { useEffect, useRef, useState } from "react";
import { clock, usd } from "../format.js";
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

          <svg className="lp-yard" viewBox="0 0 1000 300" role="img" aria-label="A truck backed onto dock door 05">
            <text className="lp-ghost" x={260 - p * 520} y="150">DETENTION</text>
            {/* dock wall and door 05 */}
            <rect x="770" y="30" width="230" height="210" fill="#2a2d33" />
            <rect x="808" y="40" width="64" height="40" rx="3" fill="#121316" stroke="#ffc400" strokeWidth="4" />
            <text x="840" y="72" textAnchor="middle" className="lp-door-no">05</text>
            <rect x="790" y="92" width="160" height="148" fill="#eef0ee" />
            {Array.from({ length: 9 }, (_, i) => <line key={i} x1="790" x2="950" y1={104 + i * 15} y2={104 + i * 15} stroke="#c3c8cf" strokeWidth="2" />)}
            <rect x="782" y="226" width="12" height="22" fill="#ffc400" />
            <rect x="946" y="226" width="12" height="22" fill="#ffc400" />
            {/* road */}
            <rect x="0" y="248" width="1000" height="52" fill="#1c1e22" />
            <line x1="0" x2="1000" y1="274" y2="274" stroke="#5e6573" strokeWidth="3" strokeDasharray="26 22" />
            {/* the truck: cab on the left, trailer reversing onto the door */}
            <g transform={`translate(${-560 + drive * 568} 0)`}>
              <rect x="420" y="108" width="356" height="122" rx="3" fill="#ffffff" />
              {Array.from({ length: 10 }, (_, i) => <line key={i} x1={452 + i * 32} x2={452 + i * 32} y1="114" y2="224" stroke="#e1e4e1" strokeWidth="2" />)}
              <text x="598" y="176" textAnchor="middle" className="lp-trailer-name">DEMO CARRIER</text>
              <text x="598" y="196" textAnchor="middle" className="lp-trailer-sub">fictional</text>
              <rect x="408" y="222" width="372" height="10" fill="#5e6573" />
              <path d="M300 230 V150 Q300 128 322 124 L372 118 Q388 116 396 130 L414 168 V230 Z" fill="#c3c8cf" />
              <path d="M330 136 L372 131 Q380 130 384 138 L396 164 H330 Z" fill="#15171c" />
              <rect x="292" y="212" width="130" height="16" rx="3" fill="#454b57" />
              {[340, 470, 506, 700, 736].map((cx) => (
                <g key={cx}>
                  <circle cx={cx} cy="236" r="18" fill="#0b0c0e" />
                  <circle cx={cx} cy="236" r="7" fill="#8b919c" />
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
              <span style={{ left: `${freeShare * 100}%` }}>Free time ends {clock(freeEnds, tz)}</span>
              <span style={{ left: "100%" }}>Released {clock(released, tz)}</span>
            </div>
          </div>

          <div className="lp-verdict" style={{ opacity: stamp, transform: `scale(${1.25 - 0.25 * stamp}) rotate(-2deg)` }}>
            <span className={`stamp lg ${owed ? "" : "red"}`}>{owed ? "Owed" : "Not owed"}</span>
            <span className="amt">{usd(amount)}</span>
            <span className="why">{billMin} billable minutes{filed ? `, claim filed ${clock(filed, tz)}` : ""}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
