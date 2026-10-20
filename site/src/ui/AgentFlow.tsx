import { clock } from "../format.js";
import type { FlowNode } from "../model/flow.js";
import { IconAgent, IconCheck, IconEmail, IconLock, IconMessages, IconStop } from "./icons.js";

const ICONS = { chat: IconMessages, mail: IconEmail, lock: IconLock, agent: IconAgent, check: IconCheck, stop: IconStop };

// AgentFlow: the load's workflow as a vertical graph, each node tagged with the AWS services that ran it.
export function AgentFlow({ nodes, timeZone, onOpen }: { nodes: FlowNode[]; timeZone: string; onOpen?: (n: FlowNode) => void }) {
  return (
    <ol className="flow">
      {nodes.map((n) => {
        const Icon = ICONS[n.icon];
        return (
          <li key={n.id} className={n.tone}>
            <span className="node" aria-hidden="true">
              <Icon />
            </span>
            <div>
              <div className="ti">{n.title}</div>
              <div className="svc">
                {n.services.map((s) => (
                  <span className="tag" key={s}>{s}</span>
                ))}
              </div>
            </div>
            <div className="when">
              {clock(n.at, timeZone)}
              <br />
              {n.raw && onOpen ? (
                <button className="linkbtn" onClick={() => onOpen(n)}>{n.outcome ?? "details"}</button>
              ) : (
                <span>{n.outcome}</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
