import { Link } from "react-router-dom";
import { FEATURED_LOAD, useLoad, useOverview } from "../model/client.js";
import { clock, dayShort, placeName, usd } from "../format.js";
import { ChannelBadge, ProvenanceBadge, channelName } from "../ui/badges.js";
import { Page } from "../ui/AppShell.js";
import { DockClockBand } from "../ui/DockClockBand.js";
import { KpiTile } from "../ui/KpiTile.js";
import { IconChevron } from "../ui/icons.js";
import { EmptyState } from "../ui/EmptyState.js";

export function Overview() {
  const ov = useOverview();
  const featured = useLoad(FEATURED_LOAD);
  const o = ov.data?.data;
  const load = featured.data?.data;
  return (
    <Page
      crumbs={[{ label: "Overview" }]}
      badges={ov.data && <ProvenanceBadge kind={ov.data.source} />}
      actions={
        <Link className="btn primary" to="/judges">
          Judges path
        </Link>
      }
    >
      {!o ? (
        <EmptyState title="Loading" />
      ) : (
        <>
          <div className="kpis">
            <KpiTile label="Claimed" value={usd(o.claimedUsd)} tone="money" />
            <KpiTile label="Claims filed" value={o.claimsFiled} note={`of ${o.loads} loads`} />
            <KpiTile label="Emails delivered" value={o.emailsDelivered} note={`of ${o.emailsSent} sent`} />
            <KpiTile label="Failovers" value={o.failovers} note="WhatsApp → RCS" />
          </div>
          {load && (
            <div style={{ marginTop: 16 }}>
              <Link to={`/loads/${load.summary.id}`} style={{ textDecoration: "none", display: "block" }} aria-label={`Open load ${load.summary.id}`}>
                <DockClockBand load={load} title={placeName(load.summary.facility)} legend compact />
              </Link>
            </div>
          )}
          <div style={{ height: 24 }} />
          <div className="grid-2">
            <div className="card">
              <div className="card-head">
                <h2>Latest</h2>
                <Link className="small golink" to="/messages">All<IconChevron className="go" /></Link>
              </div>
              <ul className="feed">
                {o.activity.slice(0, 8).flatMap((a, i, all) => {
                  const tz = load?.timeZone ?? "America/New_York";
                  const day = dayShort(a.at, tz);
                  const rows = [];
                  if (i === 0 || dayShort(all[i - 1]!.at, tz) !== day)
                    rows.push(<li key={`day-${day}`} className="day">{day === dayShort(new Date().toISOString(), tz) ? "Today" : day}</li>);
                  rows.push(
                    <li key={a.id}>
                      <span className="ts">{clock(a.at, tz)}</span>
                      <span className={`dot ${a.tone}`} aria-hidden="true" />
                      <Link className="t" to={a.href}>{a.title}</Link>
                    </li>,
                  );
                  return rows;
                })}
              </ul>
            </div>
            <div className="card">
              <div className="card-head"><h2>By channel</h2></div>
              <div className="card-body">
                <div className="chanbars">
                  {o.byChannel.map((c) => {
                    const max = Math.max(1, ...o.byChannel.map((x) => x.outbound + x.inbound));
                    return (
                      <div className="chanbar" key={c.channel}>
                        <ChannelBadge channel={c.channel} />
                        <div className="bars" aria-label={`${channelName(c.channel)}: ${c.outbound} out, ${c.inbound} in`}>
                          <i className="s" style={{ width: `${(c.outbound / max) * 100}%` }} />
                          <i className="r" style={{ width: `${(c.inbound / max) * 100}%` }} />
                        </div>
                        <span className="n">{c.outbound + c.inbound}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="legend">
                  <span><i style={{ background: "var(--ink-3)" }} />out</span>
                  <span><i style={{ background: "var(--rule-2)" }} />in</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
