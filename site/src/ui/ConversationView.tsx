import { Fragment, type ReactNode } from "react";
import { clock, dateLong } from "../format.js";
import type { ConsoleMessage } from "../model/model.js";
import { channelName } from "./badges.js";
import { IconPin } from "./icons.js";

// ConversationView: a neutral phone frame drawn from DockClock's own message records. WhatsApp and
// RCS look different on purpose (RCS uses rich cards and suggestion chips), but neither copies the
// real apps' branding. Dashed bubbles were never sent.
// A failover recorded on the load's timeline (not on a message) shows as one chip at its time.
export function failoverMarkers(timeline: Array<{ at: string; title: string; outcome?: string }>): Array<{ at: string; text: string }> {
  return timeline.filter((t) => t.outcome === "RESENT_OVER_RCS" || /switched the driver to RCS/i.test(t.title)).map((t) => ({ at: t.at, text: "WhatsApp failed → resent on RCS" }));
}

export function ConversationView({ messages, timeZone, party, upTo, title, markers = [] }: { messages: ConsoleMessage[]; timeZone: string; party: "driver" | "dispatcher"; upTo?: number; title?: string; markers?: Array<{ at: string; text: string }> }) {
  const shown = messages.filter((m) => m.party === party && (upTo === undefined || Date.parse(m.at) <= upTo));
  const lane = shown.find((m) => m.channel === "rcs") && !shown.find((m) => m.channel === "whatsapp") ? "rcs" : (messages.find((m) => m.party === party)?.channel ?? "whatsapp");
  const day = messages[0] ? dateLong(messages[0].at, timeZone) : "";
  let prevChannel: string | null = null;
  return (
    <div>
      <div className="phone">
        <div className={`screen ${lane === "rcs" ? "rcs" : ""}`}>
          <div className="head">
            <img src={`${import.meta.env.BASE_URL}avatar.svg`} alt="" />
            <div>
              <b>{title ?? "DockClock"}</b>
              <span className="small">{party === "driver" ? "Driver" : "Dispatcher"}</span>
            </div>
            <span className="chanbadge">{channelName(lane === "rcs" ? "rcs" : "whatsapp")}</span>
          </div>
          <div className="chat">
            {day && <span className="daychip">{day}</span>}
            {shown.length === 0 && <p className="small" style={{ textAlign: "center", marginTop: 40 }}>No messages yet</p>}
            {shown.map((m, i) => {
              const switched = prevChannel !== null && prevChannel !== m.channel && m.channel !== "email";
              prevChannel = m.channel === "email" ? prevChannel : m.channel;
              const prevAt = i === 0 ? "" : shown[i - 1]!.at;
              const due = markers.filter((k) => k.at > prevAt && k.at <= m.at && (upTo === undefined || Date.parse(k.at) <= upTo));
              return (
                <Fragment key={m.id}>
                  {due.map((k) => (
                    <span className="failoverchip" key={k.at}>{k.text}</span>
                  ))}
                  <Bubble m={m} timeZone={timeZone} switched={switched && due.length === 0} />
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <p className="phonenote">From message records{shown.some((m) => m.status === "not_sent") ? " ∙ dashed = not sent" : ""}</p>
    </div>
  );
}

function Bubble({ m, timeZone, switched }: { m: ConsoleMessage; timeZone: string; switched: boolean }) {
  const t = clock(m.at, timeZone);
  const tag = m.status === "not_sent" ? "not sent" : m.synthetic ? "" : (m.title ?? "");
  const failover = m.failover ? <span className="failoverchip">{channelName(m.failover.from)} failed → resent on {channelName(m.failover.to)}</span> : switched ? <span className="failoverchip">Now on {channelName(m.channel)}</span> : null;
  const cls = `bub ${m.direction === "in" ? "in" : ""} ${m.status === "not_sent" ? "unsent" : ""}`;
  const ticks = m.status === "read" ? " ✓✓" : m.status === "delivered" ? " ✓✓" : m.status === "sent" ? " ✓" : "";

  // RCS outbound: a rich card with suggestion chips, the RCS way to offer buttons.
  if (m.channel === "rcs" && m.direction === "out" && (m.kind === "template" || m.kind === "buttons" || m.kind === "card" || m.kind === "location_request")) {
    return (
      <>
        {failover}
        <div className={`richcard ${m.status === "not_sent" ? "unsent" : ""}`}>
          {m.kind !== "location_request" && <div className="hero" aria-hidden="true" />}
          <div className="rc-body">
            {tag && <span className="rc-tag">{tag}</span>}
            {m.title && <b>{m.title}</b>}
            {m.body}
          </div>
          <div className="rc-actions chips">
            {m.kind === "location_request" ? (
              <span className="sugg"><IconPin className="ic" /> Share location</span>
            ) : (
              m.buttons?.map((b) => (
                <span key={b.title} className={`sugg ${b.tapped ? "tapped" : ""}`}>{b.title}</span>
              ))
            )}
          </div>
          <span className="rc-meta">{t}{ticks}</span>
        </div>
      </>
    );
  }

  let inner: ReactNode = m.body;
  if (m.kind === "location" && m.location)
    inner = (
      <span className="loc">
        <i aria-hidden="true"><IconPin width={14} /></i>
        <span>Location shared<br /><span className="small">{m.location.insideGeofence === false ? "outside the facility" : "inside the facility ∙ no coordinates shown"}</span></span>
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
          <span>Photo</span><b>{f.photoStored ? "stored" : "not stored"}</b>
        </span>
      </>
    );
  }
  if (m.kind === "image" && m.photo)
    inner = (
      <>
        <img src={m.photo.url} alt="Bill of lading photo" />
        <span className="small">{m.photo.badge}</span>
      </>
    );
  return (
    <>
      {failover}
      <div className={cls}>
        {tag && <span className="src">{tag}</span>}
        {inner}
        {m.kind === "location_request" && <div className="btns"><div>Send location</div></div>}
        {m.kind === "flow" && <div className="btns"><div>Open form</div></div>}
        {m.buttons && m.direction === "out" && (
          <div className="btns">
            {m.buttons.map((b) => (
              <div key={b.title} className={b.tapped ? "tapped" : ""}>{b.title}</div>
            ))}
          </div>
        )}
        <span className="meta">{t}{ticks}</span>
      </div>
    </>
  );
}
