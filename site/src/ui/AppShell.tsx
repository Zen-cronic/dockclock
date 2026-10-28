import type { ReactNode } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { IconJudges, IconLoads, IconMessages, IconOverview } from "./icons.js";

const NAV = [
  { to: "/overview", label: "Overview", icon: IconOverview, end: true },
  { to: "/messages", label: "Messages", icon: IconMessages, end: false },
  { to: "/loads", label: "Loads", icon: IconLoads, end: false },
];

function Brand() {
  return (
    <Link className="brand" to="/overview" aria-label="DockClock Console home">
      <img src={`${import.meta.env.BASE_URL}brand-mark.svg`} alt="" />
      <b>DockClock</b>
    </Link>
  );
}

// NavRail: sign-black navigation. Collapses to a top bar with four equal tabs under 860 px.
export function NavRail() {
  return (
    <nav className="nav" aria-label="Console">
      <Brand />
      <div className="nav-label">Monitor</div>
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} className={({ isActive }) => `item ${isActive ? "active" : ""}`}>
          <Icon />
          {label}
        </NavLink>
      ))}
      <div className="nav-label">Judges</div>
      <NavLink to="/judges" className={({ isActive }) => `item ${isActive ? "active" : ""}`}>
        <IconJudges />
        Judges path
      </NavLink>
      <div className="foot">
        <b>Demo workspace</b>
      </div>
    </nav>
  );
}

function MobileNav() {
  const items = [...NAV, { to: "/judges", label: "Judges", icon: IconJudges, end: false }];
  return (
    <>
      <div className="mtop">
        <Brand />
      </div>
      <nav className="mnav" aria-label="Console">
        {items.map(({ to, label, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")}>
            {label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

export function AppShell() {
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <NavRail />
      <div className="content">
        <MobileNav />
        <Outlet />
      </div>
    </div>
  );
}

export interface Crumb {
  to?: string;
  label: string;
}

// TopBar: breadcrumb, quiet provenance badges, at most two actions.
export function TopBar({ crumbs, badges, actions }: { crumbs: Crumb[]; badges?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={`${c.label}-${i}`} style={{ display: "contents" }}>
            {i > 0 && <span className="sep">/</span>}
            {c.to ? <Link to={c.to}>{c.label}</Link> : <span className="here">{c.label}</span>}
          </span>
        ))}
      </div>
      {badges}
      <div className="spacer" />
      {actions}
    </header>
  );
}

export function Page({ crumbs, badges, actions, strip, children }: { crumbs: Crumb[]; badges?: ReactNode; actions?: ReactNode; strip?: ReactNode; children: ReactNode }) {
  return (
    <>
      <TopBar crumbs={crumbs} badges={badges} actions={actions} />
      {strip && <div className="teststrip" role="note">{strip}</div>}
      <main className="page" id="main" tabIndex={-1}>{children}</main>
    </>
  );
}
