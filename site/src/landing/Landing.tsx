import "./fonts.js";
import "./landing.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { clock, zoneName } from "../format.js";
import { IconChevron } from "../ui/icons.js";
import { HeroPlayer, StaticHero, Storyboard } from "./HeroPlayer.js";
import { heroStory, type Story } from "./story.js";
import { useMedia } from "./media.js";
import { WaitScene } from "./WaitScene.js";

// The landing page at "/". It tells one recorded load from dispatch to the filed claim, then
// points to the phone demo, the judge path and the console. Its own type leads; every product
// surface inside it keeps the console's Door 05 type.

export const TITLE = "DockClock: detention pay, claimed with proof";


function useInView<T extends Element>(threshold = 0.4) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) {
        setSeen(true);
        io.disconnect();
      }
    }, { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return [ref, seen] as const;
}

function Go({ children, to, className = "" }: { children: ReactNode; to: string; className?: string }) {
  const inner = <>{children}<IconChevron className="go" /></>;
  return to.startsWith("#") ? <a className={className} href={to}>{inner}</a> : <Link className={className} to={to}>{inner}</Link>;
}

function Brand() {
  return (
    <Link className="lp-brand" to="/" aria-label="DockClock home">
      <img src={`${import.meta.env.BASE_URL}brand-mark.svg`} alt="" width={30} height={30} />
      <b>DockClock</b>
    </Link>
  );
}

function Header() {
  return (
    <header className="lp-header">
      <Brand />
      <nav aria-label="Site" className="lp-nav">
        <a href="#wait" className="hide-s">How it works</a>
        <a href="#try" className="hide-s">Try it</a>
        <Link to="/overview">Console</Link>
        <Link className="lp-btn sm dark" to="/judges">Judge path</Link>
      </nav>
    </header>
  );
}

// A number that counts up once it scrolls into view.
function CountUp({ value, format, reduced }: { value: number; format: (n: number) => string; reduced: boolean }) {
  const [ref, seen] = useInView<HTMLSpanElement>(0.6);
  const [n, setN] = useState(reduced ? value : 0);
  useEffect(() => {
    if (reduced || !seen) {
      if (reduced) setN(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 1200);
      setN(value * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, reduced, value]);
  return <span ref={ref} aria-label={format(value)}><span aria-hidden="true">{format(n)}</span></span>;
}

// A sentence whose words go from grey to ink as it scrolls up the screen.
function FillText({ text, reduced }: { text: string; reduced: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [k, setK] = useState(reduced ? 1 : 0);
  useEffect(() => {
    if (reduced) {
      setK(1);
      return;
    }
    let raf = 0;
    const read = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      setK(Math.min(1, Math.max(0, (vh * 0.85 - r.top) / (vh * 0.5))));
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      window.removeEventListener("scroll", on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [reduced]);
  const words = text.split(" ");
  return (
    <p className="lp-fill" ref={ref} aria-label={text}>
      {words.map((w, i) => (
        <span key={i} aria-hidden="true" className={i / words.length < k ? "in" : ""}>{w} </span>
      ))}
    </p>
  );
}

function Refusals({ story }: { story: Story }) {
  const { load, chapters } = story;
  const tz = load.timeZone;
  const at = (key: string) => chapters.find((c) => c.key === key)?.at;
  const t = (iso?: string | null) => (iso ? clock(iso, tz) : "");
  const rows = [
    { no: "You weren't there that long.", yes: "Two location pins, each with WhatsApp's server time.", proof: `Arrived ${t(load.clock.arrivedAt)} ∙ released ${t(load.clock.releasedAt)}`, step: "proved" },
    { no: "You never gave notice.", yes: "The notice is emailed before free time ends, and its delivery is recorded.", proof: `Notice ${t(at("notice"))} ∙ free time ended ${t(load.clock.freeTimeEndsAt)}`, step: "notice" },
    { no: "You filed too late.", yes: "The agent files minutes after dispatch approves, with the contract's own numbers.", proof: `Approved ${t(at("approved"))} ∙ filed ${t(at("filed"))}`, step: "filed" },
    { no: "The evidence was edited.", yes: "The pack is signed with AWS KMS. Change one byte and the check fails, in your browser.", proof: "KMS signature ∙ S3 Object Lock", step: "break" },
    { no: "It isn't owed.", yes: "The contract decides, not the model. If the clause says no, nothing is sent.", proof: "Billable ∙ not billable ∙ needs a person", step: "change" },
  ];
  return (
    <section className="lp-sec lp-refuse" aria-labelledby="refuse-h">
      <div className="lp-wrap">
        <h2 id="refuse-h" className="lp-h2">Five ways a claim gets refused. Each has an answer on file.</h2>
        <ol className="lp-rows">
          {rows.map((r, i) => (
            <li key={r.step}>
              <span className="n">{String(i + 1).padStart(2, "0")}</span>
              <q className="no">{r.no}</q>
              <div className="yes">
                <p>{r.yes}</p>
                <span className="proof">{r.proof}</span>
              </div>
              <Go to={`/judges/${r.step}`} className="lp-golink">See it</Go>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Numbers({ reduced }: { reduced: boolean }) {
  const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  return (
    <section className="lp-sec lp-numbers" aria-labelledby="num-h">
      <div className="lp-wrap">
        <h2 id="num-h" className="visually-hidden">Why it matters</h2>
        <FillText reduced={reduced} text="Nearly half of detention invoices never get paid." />
        <p className="lp-lead lp-num-lead">Carriers are paid on about 55% of the detention invoices they send. Many never send one, because they expect the refusal.</p>
        <dl className="lp-figs">
          <div><dt>of detention invoices get paid</dt><dd><CountUp value={55} format={(n) => `${Math.round(n)}%`} reduced={reduced} /></dd></div>
          <div><dt>unpaid detention per driver, per year</dt><dd><CountUp value={5104} format={money} reduced={reduced} /></dd></div>
          <div><dt>a year for a fleet of 40 trucks</dt><dd className="money"><CountUp value={204000} format={money} reduced={reduced} /></dd></div>
        </dl>
        <p className="lp-source">ATRI, Costs and Consequences of Truck Driver Detention (2024), survey estimates: $5,103.95 per truckload driver a year; 40 drivers × $5,103.95 ≈ $204,000.</p>
      </div>
    </section>
  );
}

function Try() {
  return (
    <section className="lp-sec lp-try" id="try" aria-labelledby="try-h">
      <div className="lp-wrap lp-try-grid">
        <div>
          <h2 id="try-h" className="lp-h2">Try it on your phone.</h2>
          <p className="lp-lead">Send <b className="kbd">DEMO</b> on WhatsApp to the number on our Devpost page. You play the driver and the dispatcher. Most of the ten minutes is the real wait.</p>
          <p className="lp-small">DEMO ES for Spanish, DEMO FR for Québécois French. The notice and claim emails go to our test mailbox, not to you.</p>
        </div>
        <ol className="lp-steps">
          <li><b>Tap Arrived</b> and share your location. In the demo any location counts.</li>
          <li><b>Wait past five minutes.</b> The notice goes out and the chat tells you.</li>
          <li><b>Tap Released,</b> share your location again and photograph the times written on paper.</li>
          <li><b>Tap Approve claim.</b> The agent files it and sends you the amount and the evidence pack's fingerprint.</li>
        </ol>
      </div>
    </section>
  );
}

function Closing({ story }: { story: Story | null }) {
  const pack = story?.load.packSummary;
  const tz = story?.load.timeZone ?? "America/New_York";
  return (
    <section className="lp-sec lp-close" aria-labelledby="close-h">
      <div className="lp-wrap lp-close-grid">
        <div>
          <h2 id="close-h" className="lp-h2">No phone? Follow one claim past the five reasons brokers give for not paying.</h2>
          <p className="lp-lead">The judge path reads the live system. Break the signature yourself, or change one fact and watch the verdict move.</p>
        <div className="lp-cta">
          <Go to="/judges" className="lp-btn primary lg">Open the judge path</Go>
          <Go to="/overview" className="lp-btn ghost lg">Open the console</Go>
        </div>
        </div>
        {pack && story && (
          <figure className="lp-pack">
            <figcaption>Evidence pack</figcaption>
            <dl>
              <dt>Load</dt><dd>{story.load.summary.id}</dd>
              <dt>Sealed</dt><dd>{clock(pack.sealedAt, tz)} {zoneName(pack.sealedAt, tz)}</dd>
              <dt>sha256</dt><dd className="hash">{pack.digestSha256.slice(0, 16)}…</dd>
              <dt>Signature</dt><dd>AWS KMS, ECDSA P-256</dd>
              <dt>Stored</dt><dd>S3 Object Lock</dd>
            </dl>
            <Go to="/judges/break" className="lp-golink">Change a byte and check it</Go>
          </figure>
        )}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="lp-foot">
      <div className="lp-wrap lp-foot-grid">
        <Brand />
        <nav aria-label="Console">
          <Link to="/overview">Console</Link>
          <Link to="/messages">Messages</Link>
          <Link to="/loads">Loads</Link>
          <Link to="/judges">Judge path</Link>
        </nav>
        <p>Demo workspace. Every company on this site is fictional. Built on AWS End User Messaging Social, Step Functions, KMS, SES and Bedrock AgentCore.</p>
      </div>
    </footer>
  );
}

export function Landing() {
  const reduced = useMedia("(prefers-reduced-motion: reduce)", true);
  // Under reduced motion the hero is still until the visitor asks to play it.
  const [chosePlay, setChosePlay] = useState(false);
  const story = useMemo(() => heroStory(), []);
  useEffect(() => {
    const was = document.title;
    document.title = TITLE;
    return () => {
      document.title = was;
    };
  }, []);
  return (
    <div className="lp">
      <a className="skip" href="#lp-main">Skip to content</a>
      <Header />
      <main id="lp-main" tabIndex={-1}>
        <section className="lp-hero" aria-labelledby="hero-h">
          <div className="lp-hero-grid">
            <div className="lp-hero-copy">
              <p className="lp-kicker">Truck detention, claimed with proof</p>
              <h1 id="hero-h" className="lp-h1">Get paid for the hours at the dock.</h1>
              <p className="lp-lead">Your driver taps two buttons on WhatsApp. DockClock gives notice, seals the proof and files the claim.</p>
              <div className="lp-cta">
                <Go to="#try" className="lp-btn primary">Try it on your phone</Go>
                <Go to="/judges" className="lp-btn ghost">Open the judge path</Go>
              </div>
            </div>
            {story && (reduced && !chosePlay ? <StaticHero story={story} onPlay={() => setChosePlay(true)} /> : <HeroPlayer story={story} />)}
          </div>
          {story && reduced && <Storyboard story={story} />}
        </section>
        {story && <WaitScene story={story} reduced={reduced} />}
        {story && <Refusals story={story} />}
        <Numbers reduced={reduced} />
        <Try />
        <Closing story={story} />
      </main>
      <Footer />
    </div>
  );
}

export default Landing;
