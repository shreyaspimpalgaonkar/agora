import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { send } from "../lib/api";
import { useStore, serverNow } from "../lib/store";
import { useLive } from "../lib/useData";
import { Section, Status, ToneIcon, useTick } from "../components/ui";
import { Glyph } from "../components/Glyph";
import { clock, dur, ago } from "../lib/format";

type Health = {
  hub: { pid: number; started_at: number; uptime_s: number; restarts: number; streams: number; loops: number };
  recoveries: Record<string, number>;
  live_processes: number;
  live: { id: string; agent_id: string; pid: number; last_event_at: number }[];
  outage_until: number | null;
};

const LEVELS = ["all", "error", "warn", "ok", "info"] as const;

export default function System() {
  useTick(2000);
  const role = useStore((s) => s.role);
  const sys = useStore((s) => s.sys);
  const agents = useStore((s) => s.agents);
  const health = useLive<Health>("/system/health", { every: 5000, on: ["sys"], debounce: 800 });
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("all");
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const h = health.data;
  const shown = useMemo(() => sys.filter((e) => (level === "all" || e.level === level) && (!kind || e.kind.startsWith(kind))), [sys, level, kind]);
  const kinds = useMemo(() => [...new Set(sys.map((e) => e.kind.split(".")[0]))], [sys]);

  const chaos = async (action: string, body?: unknown) => {
    setBusy(action); setMsg(null);
    try {
      const r = await send<any>("POST", `/chaos/${action}`, body ?? {});
      setMsg(action === "kill" ? (r.handle ? `Killed ${r.handle} (pid ${r.pid}). Watch it come back below.` : r.error) : action === "restart-hub" ? "Hub restarting. This page reconnects by itself in a few seconds." : action === "quota" ? (r.until ? `Subscription paused until ${clock(r.until)} UTC. Watch its agents wait, then resume.` : r.error) : `Agent API is down for ${(body as any)?.seconds ?? 45}s. Board calls retry inside each agent.`);
    } catch (e: any) { setMsg(e.message); } finally { setBusy(null); }
  };

  const rec = h?.recoveries ?? {};
  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">Reliability</div>
          <h1 className="page-title">The run <em>does not stop</em></h1>
          <p className="page-lede">Agents run as detached processes that write to disk, so a crash of the web server does not touch them: the next server re-attaches and keeps reading. A killed or stalled agent resumes its own Codex session. A subscription that hits its usage limit pauses alone while the others keep going. Everything below is the live supervisor log.</p>
        </div>
      </div>

      <div className="stats" style={{ marginBottom: 14 }}>
        <div className="panel stat"><div className="stat-label"><ToneIcon tone="ok" />Hub uptime</div><div className="stat-value">{h ? dur(h.hub.uptime_s * 1000) : "—"}</div><div className="stat-sub">pid {h?.hub.pid} · {h?.hub.restarts ?? 0} restarts so far</div></div>
        <div className="panel stat"><div className="stat-label">Live agent processes</div><div className="stat-value">{h?.live_processes ?? "—"}</div><div className="stat-sub">{h?.hub.loops ?? 0} supervisor loops · {h?.hub.streams ?? 0} viewers</div></div>
        <div className="panel stat"><div className="stat-label">Crashes recovered</div><div className="stat-value">{rec.resumed ?? 0}</div><div className="stat-sub">{rec.crashes ?? 0} crashes · {rec.stalls ?? 0} stalls</div></div>
        <div className="panel stat"><div className="stat-label">Re-attached after hub restart</div><div className="stat-value">{rec.reattached ?? 0}</div><div className="stat-sub">processes adopted by a new hub</div></div>
        <div className="panel stat"><div className="stat-label">Sessions completed</div><div className="stat-value">{rec.completed ?? 0}</div><div className="stat-sub">{rec.failed ?? 0} failed · {rec.nudges ?? 0} nudged to file</div></div>
        <div className="panel stat"><div className="stat-label">Quota pauses</div><div className="stat-value">{rec.rate_limited ?? 0}</div><div className="stat-sub">{rec.lease_expired ?? 0} leases lapsed</div></div>
      </div>

      <div className="grid g-12">
        <Section index="01" title="Chaos tests" className="span-5" right={role !== "admin" ? <span className="tag">operator key needed</span> : null}>
          <div className="col" style={{ gap: 12 }}>
            <ChaosRow title="Kill an agent process" what="SIGKILL a random running codex process. Expected: the supervisor sees the exit, waits a few seconds, and resumes the same Codex session, which then re-reads its inbox." disabled={role !== "admin" || !!busy} onClick={() => chaos("kill")} label="Kill one ⚡" />
            <ChaosRow title="Restart the hub" what="Exit the web server. Expected: the process manager restarts it, the new hub re-attaches to every agent that is still running, and this page reconnects." disabled={role !== "admin" || !!busy} onClick={() => chaos("restart-hub")} label="Restart hub" />
            <ChaosRow title="Usage limit on one subscription, 2 minutes" what="Act as if the first subscription hit its quota. Expected: its sessions end and free their problems, it pauses with a resume time, any other subscription keeps working, and after two minutes it resumes by itself." disabled={role !== "admin" || !!busy} onClick={() => chaos("quota", { seconds: 120 })} label="Exhaust quota" />
            <ChaosRow title="Board outage, 45 seconds" what="The agent API answers 503. Expected: board tools inside each agent retry with backoff; agents keep thinking and post once it is back." disabled={role !== "admin" || !!busy} onClick={() => chaos("outage", { seconds: 45 })} label="Take board down" />
            {h?.outage_until && <div className="banner warn">Board outage in progress · back in {Math.max(0, Math.round((h.outage_until - serverNow()) / 1000))}s</div>}
            {msg && <div className="banner">{msg}</div>}
          </div>
        </Section>
        <Section index="02" title="Live processes" className="span-7" bodyClass="tight">
          <table className="table">
            <thead><tr><th>Agent</th><th>Session</th><th className="r">PID</th><th className="r">Last event</th></tr></thead>
            <tbody>
              {(h?.live ?? []).length === 0 && <tr><td colSpan={4}><div className="empty" style={{ padding: 12 }}>No codex process is running.</div></td></tr>}
              {(h?.live ?? []).map((p) => (
                <tr key={p.id}>
                  <td><Link to={`/agents/${p.agent_id}`} className="row" style={{ gap: 6 }}><Glyph id={p.agent_id} size={18} live /><span className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>{agents[p.agent_id]?.handle}</span></Link></td>
                  <td><Link to={`/agents/${p.agent_id}?run=${p.id}`} className="mono tag">{p.id}</Link></td>
                  <td className="r mono num">{p.pid}</td>
                  <td className="r mono tag">{ago(p.last_event_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section index="03" title="Supervisor log" className="span-12" bodyClass="tight" right={
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <div className="seg">{LEVELS.map((l) => <button key={l} className={level === l ? "on" : ""} onClick={() => setLevel(l)}>{l}</button>)}</div>
            <select className="input" style={{ height: 28 }} value={kind} onChange={(e) => setKind(e.target.value)}><option value="">all kinds</option>{kinds.map((k) => <option key={k}>{k}</option>)}</select>
          </div>}>
          <div style={{ maxHeight: 640, overflow: "auto" }}>
            {shown.map((e) => (
              <div key={e.id} className="row" style={{ padding: "7px 14px", borderBottom: "1px solid var(--line-2)", gap: 10, alignItems: "flex-start" }}>
                <ToneIcon tone={e.level === "error" ? "err" : e.level === "warn" ? "warn" : e.level === "ok" ? "ok" : "idle"} />
                <span className="mono tag" style={{ width: 62, flex: "none" }}>{clock(e.ts, true)}</span>
                <span className="mono tag hide-sm" style={{ width: 150, flex: "none" }}>{e.kind}</span>
                {e.agent_id && <Link to={`/agents/${e.agent_id}`} style={{ flex: "none" }}><Glyph id={e.agent_id} size={16} /></Link>}
                <span className="grow" style={{ fontSize: 13 }}>{e.message}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function ChaosRow({ title, what, label, onClick, disabled }: { title: string; what: string; label: string; onClick: () => void; disabled: boolean }) {
  return (
    <div className="row" style={{ gap: 12, alignItems: "flex-start", borderBottom: "1px solid var(--line-2)", paddingBottom: 12 }}>
      <div className="grow"><div style={{ fontWeight: 600, fontSize: 13.5 }}>{title}</div><div className="dim" style={{ fontSize: 12.5 }}>{what}</div></div>
      <button className="btn sm danger" disabled={disabled} onClick={onClick}>{label}</button>
    </div>
  );
}

export { Status };
