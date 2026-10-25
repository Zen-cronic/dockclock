import { useEffect, useRef, type ReactNode } from "react";
import { clock, dateLong, zoneName } from "../format.js";
import type { ConsoleEmail, ConsoleMessage } from "../model/model.js";
import { IconDoc, IconPin } from "../ui/icons.js";

// The hero's devices. The phone reuses the console's phone-frame classes (.phone, .screen, .bub),
// so a message looks the same here as on /loads/<id>. Times are the recorded ones.

export function Phone({ party, messages, timeZone, pressing, tapped, anyLocation, scroll = true }: {
  party: "driver" | "dispatcher";
  messages: ConsoleMessage[];
  timeZone: string;
  // a button being pressed right now, and buttons already tapped: "<messageId>:<title>"
  pressing?: string | null;
  tapped?: Set<string>;
  anyLocation?: boolean;
  scroll?: boolean;
}) {
  const chat = useRef<HTMLDivElement>(null);
  const last = messages.at(-1)?.id;
  useEffect(() => {
    const el = chat.current;
    if (!el || !scroll) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [last, pressing, scroll]);
  const day = messages[0] ? dateLong(messages[0].at, timeZone) : "";
  return (
    <div className="phone lp-phone">
      <div className="screen">
        <div className="head">
          <img src={`${import.meta.env.BASE_URL}brand-mark.svg`} alt="" />
          <div>
            <b>DockClock</b>
            <span className="small">{party === "driver" ? "Driver" : "Dispatch"}</span>
          </div>
          <span className="chanbadge">WhatsApp</span>
        </div>
        <div className="chat" ref={chat}>
          {day && <span className="daychip">{day}</span>}
          {messages.map((m) => (
            <Bubble key={m.id} m={m} timeZone={timeZone} pressing={pressing} tapped={tapped} anyLocation={anyLocation} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Bubble({ m, timeZone, pressing, tapped, anyLocation }: { m: ConsoleMessage; timeZone: string; pressing?: string | null | undefined; tapped?: Set<string> | undefined; anyLocation?: boolean | undefined }) {
  const ticks = m.status === "read" || m.status === "delivered" ? " ✓✓" : m.status === "sent" ? " ✓" : "";
  let inner: ReactNode = m.body;
  if (m.kind === "location")
    inner = (
      <span className="loc">
        <i aria-hidden="true"><IconPin width={14} /></i>
        <span>Location shared<br /><span className="small">{anyLocation ? "any location accepted ∙ no coordinates shown" : "no coordinates shown"}</span></span>
      </span>
    );
  if (m.kind === "flow_reply" && m.flowReply) {
    const f = m.flowReply;
    inner = (
      <>
        Bill of lading form
        <span className="kv">
          <span>In</span><b>{f.inTime ?? "—"}</b>
          <span>Out</span><b>{f.outTime ?? "—"}</b>
          <span>Signed</span><b>{f.receiverSigned ? "yes" : "no"}</b>
          <span>Photo</span><b>{f.photoStored ? "camera, stored" : "none"}</b>
        </span>
      </>
    );
  }
  const offers = m.direction === "out" ? (m.buttons ?? []) : [];
  const extra = !offers.length && m.kind === "location_request" ? ["Send location"] : !offers.length && m.kind === "flow" ? ["Open form"] : [];
  return (
    <div className={`bub lp-rise ${m.direction === "in" ? "in" : ""}`}>
      {inner}
      {(offers.length > 0 || extra.length > 0) && (
        <div className="btns">
          {offers.map((b) => {
            const id = `${m.id}:${b.title}`;
            return <div key={b.title} className={`${tapped?.has(id) ? "tapped" : ""} ${pressing === id ? "lp-press" : ""}`}>{b.title}</div>;
          })}
          {extra.map((t) => <div key={t}>{t}</div>)}
        </div>
      )}
      <span className="meta">{clock(m.at, timeZone)}{ticks}</span>
    </div>
  );
}

// The claim and notice emails as they reached the receiver's test mailbox. The body stops at the
// signature separator; the hashes below it are in the console's mail view.
export function Mail({ email, body, timeZone }: { email: ConsoleEmail; body: string | null; timeZone: string }) {
  const text = body?.split(/\n--\n/)[0]?.trim() ?? null;
  const at = email.deliveredAt ?? email.sentAt;
  return (
    <div className="lp-mail">
      <div className="lp-mail-bar">
        <span>Inbox</span>
        <span className="lp-mail-who">{email.to}</span>
      </div>
      <div className="lp-mail-hdr">
        <span>From</span><b>{email.from}</b>
        <span>To</span><span>{email.to}</span>
        <span>{email.status === "delivered" ? "Delivered" : "Sent"}</span><span>{clock(at, timeZone)} {zoneName(at, timeZone)}</span>
      </div>
      <h4 className="lp-mail-subj">{email.subject}</h4>
      {text ? <pre className="lp-mail-body">{text}</pre> : <p className="small">Body not stored.</p>}
      {email.attachments.length > 0 && (
        <div className="lp-mail-files">
          {email.attachments.map((a) => (
            <span key={a.name} className="lp-file"><IconDoc width={14} />{a.name.endsWith(".json") ? "Signed evidence pack (.json)" : a.name.endsWith(".pem") ? "Public key (.pem)" : a.name}</span>
          ))}
        </div>
      )}
    </div>
  );
}
