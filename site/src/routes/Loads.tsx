import { useNavigate } from "react-router-dom";
import { runLabel } from "../copy/provenance.js";
import { allReplayDetails, useLoads } from "../model/client.js";
import { usd } from "../format.js";
import { Page } from "../ui/AppShell.js";
import { ChannelBadge, ProvenanceBadge, Stamp } from "../ui/badges.js";
import { EmptyState } from "../ui/EmptyState.js";

export function Loads() {
  const q = useLoads();
  const nav = useNavigate();
  const loads = q.data?.data ?? [];
  const details = allReplayDetails();
  return (
    <Page crumbs={[{ label: "Loads" }]} badges={q.data && <ProvenanceBadge kind={q.data.source} />}>
      <div className="card">
        {loads.length === 0 ? (
          <EmptyState title="No loads yet" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Load</th>
                <th className="hide-m">Facility</th>
                <th>Channel</th>
                <th className="hide-m">Run</th>
                <th>Verdict</th>
                <th>Owed</th>
              </tr>
            </thead>
            <tbody>
              {loads.map((l) => {
                const d = details.find((x) => x.summary.id === l.id);
                return (
                  <tr key={l.id} onClick={() => nav(`/loads/${l.id}`)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && nav(`/loads/${l.id}`)}>
                    <td className="id">{l.id}</td>
                    <td className="hide-m">{l.facility}</td>
                    <td><ChannelBadge channel={l.channel} />{l.failover ? <span className="small"> · failover</span> : null}</td>
                    <td className="hide-m"><span className="badge test">{d ? runLabel(d) : l.runKind}</span></td>
                    <td><Stamp verdict={l.verdict} /></td>
                    <td className="num">{usd(l.amountUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}
