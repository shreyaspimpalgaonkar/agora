import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import { useStore, serverNow } from "../lib/store";
import { clock } from "../lib/format";
import { useTick } from "./ui";
import { AttachButton } from "./Attach";
import { Glyph } from "./Glyph";

function Logo() {
  return (
    <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="var(--bg)" strokeWidth="1.4" strokeDasharray="2 2.8">
        <animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="40s" repeatCount="indefinite" />
      </circle>
      <circle cx="16" cy="16" r="3.4" fill="var(--signal)" />
      <circle cx="24.6" cy="10.4" r="1.7" fill="var(--bg)" />
      <circle cx="8.6" cy="21.4" r="1.7" fill="var(--bg)" />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme ?? "");
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    try { if (theme) localStorage.setItem("agora-theme", theme); else localStorage.removeItem("agora-theme"); } catch { /* ignore */ }
  }, [theme]);
  const dark = theme === "dark" || (!theme && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  return (
    <button className="btn icon ghost" title={dark ? "Switch to light" : "Switch to night shift"} onClick={() => setTheme(dark ? "light" : "dark")} aria-label="Toggle theme">
      {dark ? (
        <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.2" fill="currentColor" /><g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">{[0, 45, 90, 135, 180, 225, 270, 315].map((a) => <line key={a} x1={8 + 5 * Math.cos((a * Math.PI) / 180)} y1={8 + 5 * Math.sin((a * Math.PI) / 180)} x2={8 + 6.6 * Math.cos((a * Math.PI) / 180)} y2={8 + 6.6 * Math.sin((a * Math.PI) / 180)} />)}</g></svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16"><path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3Z" fill="currentColor" /></svg>
      )}
    </button>
  );
}

function Ticker() {
  const activity = useStore((s) => s.activity);
  const posts = useStore((s) => s.posts);
  const agents = useStore((s) => s.agents);
  const items = useMemo(() => {
    const fromPosts = posts.slice(0, 14).map((p) => ({
      ts: p.ts, key: `p${p.id}`, agent: p.agent_id,
      text: p.author_type === "system" ? p.body.replace(/[*@>]/g, "").slice(0, 110) : `${p.author} posted ${p.kind.replace("_", " ")}${p.problem_id ? ` on #${p.problem_id}` : ""}${p.title ? `: ${p.title}` : ""}`,
    }));
    const fromAct = activity.filter((a) => a.kind !== "reasoning").slice(0, 10).map((a, i) => ({
      ts: a.ts, key: `a${a.run_id}${a.ts}${i}`, agent: a.agent_id,
      text: `${agents[a.agent_id]?.handle ?? "agent"} · ${a.label.replace(/^board_/, "board ").replace("_", " ")}`,
    }));
    return [...fromPosts, ...fromAct].sort((a, b) => b.ts - a.ts).slice(0, 18);
  }, [activity, posts, agents]);
  if (!items.length) return null;
  const row = items.map((it) => (
    <span className="ticker-item" key={it.key}>
      {it.agent ? <Glyph id={it.agent} size={14} /> : <span style={{ opacity: 0.6 }}>◇</span>}
      {it.text}
      <span style={{ opacity: 0.45 }}>{clock(it.ts)}</span>
    </span>
  ));
  return (
    <div className="ticker" aria-label="Live activity">
      <div className="ticker-label"><span className="dot live" style={{ background: "#fff" }} />LIVE</div>
      <div className="ticker-track">{row}{row}</div>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  useTick(1000);
  const connected = useStore((s) => s.connected);
  const transport = useStore((s) => s.transport);
  const role = useStore((s) => s.role);
  const agents = useStore((s) => s.agents);
  const subs = useStore((s) => s.subs);
  const stats = useStore((s) => s.stats);
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const running = Object.values(agents).filter((a) => a.status === "running").length;
  const liveAgents = Object.values(agents).filter((a) => a.status !== "retired").length;
  const nav: [string, string, ReactNode?][] = [
    ["/", "Overview"],
    ["/board", "Board", stats ? <span className="count">{stats.agentPosts}</span> : null],
    ["/agents", "Agents", <span className="count">{running}/{liveAgents}</span>],
    ["/coordination", "Coordination"],
    ["/problems", "Problems", stats ? <span className="count">{stats.problems}</span> : null],
    ["/subscriptions", "Subscriptions", <span className="count">{Object.keys(subs).length}</span>],
    ["/system", "System"],
  ];
  return (
    <div className="shell">
      <header className="topbar">
        <button className="btn icon ghost mobile-nav-btn" onClick={() => setOpen((o) => !o)} aria-label="Menu">
          <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        <Link to="/" className="brand" aria-label="Agora home">
          <Logo />
          <span className="brand-word">agora</span>
          <span className="brand-sub">open problems<br />codex swarm</span>
        </Link>
        <nav className={`nav ${open ? "open" : ""}`}>
          {nav.map(([to, label, extra]) => (
            <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>{label}{extra}</NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="conn hide-sm" title={connected ? (transport === "poll" ? "Live updates by long polling (this network buffers event streams)" : "Live event stream connected") : "Reconnecting…"}>
            <span className={`dot ${connected ? "live" : "warn"}`} />{connected ? (transport === "poll" ? "live · poll" : "live") : "reconnecting"}
          </span>
          <span className="clock hide-sm num">{clock(serverNow(), true)} UTC</span>
          {role === "admin" && <span className="chip hide-sm" title="You hold the operator key">operator</span>}
          <ThemeToggle />
          <AttachButton />
        </div>
      </header>
      <main className="main">{children}</main>
      <Ticker />
    </div>
  );
}
