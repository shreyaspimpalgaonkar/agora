import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { send, manageTokens } from "../lib/api";
import { useStore, serverNow } from "../lib/store";
import type { Sub } from "../lib/types";
import { Glyph } from "../components/Glyph";
import { Status, ToneIcon, useTick } from "../components/ui";
import { openAttach } from "../components/Attach";
import { subTone, agentTone } from "../lib/colors";
import { ago, compact, untilTs, dateTime } from "../lib/format";

const MODELS = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra"];
const EFFORTS = ["medium", "high", "xhigh", "max"];

export default function Subscriptions() {
  useTick(5000);
  const subs = useStore((s) => s.subs);
  const role = useStore((s) => s.role);
  const loc = useLocation();
  useEffect(() => { if (loc.hash) setTimeout(() => document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" }), 200); }, [loc.hash]);
  const list = Object.values(subs).sort((a, b) => a.created_at - b.created_at);
  const mine = manageTokens();

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">{list.length} attached · {list.filter((s) => s.status === "active").length} active</div>
          <h1 className="page-title">Subscriptions, <em>checked live</em></h1>
          <p className="page-lede">Every subscription is proven before its agents start: Agora reads the login (account, plan, token expiry), then makes a real round trip through Codex on that login. Its agents report the plan's quota as they work, so you can see whose quota each agent spends.</p>
        </div>
        <div className="spacer" />
        <button className="btn signal" style={{ height: 40, padding: "0 18px" }} onClick={openAttach}>Attach a subscription</button>
      </div>
      {list.length === 0 && <div className="panel empty">Nothing attached yet.</div>}
      <div className="col" style={{ gap: 14 }}>
        {list.map((s) => <SubCard key={s.id} s={s} canManage={role === "admin" || !!mine[s.id]} />)}
      </div>
    </div>
  );
}

function SubCard({ s, canManage }: { s: Sub; canManage: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const agents = useStore((st) => st.agents);
  const rl = s.rate_limits;
  const used = Math.max(rl?.primary?.used_percent ?? 0, rl?.secondary?.used_percent ?? 0);
  const win = rl?.primary?.window_minutes;
  const act = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); setErr(null); try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(null); } };
  const patch = (body: Record<string, unknown>) => act("save", () => send("PATCH", `/subs/${s.id}`, body, s.id));
  const expiresIn = s.token_expires_at ? s.token_expires_at - serverNow() : null;

  return (
    <section id={s.id} className="panel">
      <div className="panel-head" style={{ gap: 12 }}>
        <div className="grow">
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <h2 className="h2" style={{ fontSize: 17 }}>{s.label}</h2>
            <Status tone={subTone(s.status)} label={s.status === "rate_limited" ? `usage limit · resumes ${untilTs(s.paused_until)}` : s.status.replace("_", " ")} />
            {s.owner && <span className="tag">owner: {s.owner}</span>}
          </div>
          <div className="tag">{s.id} · attached {ago(s.created_at)} · {s.source === "device" ? "device-code sign-in (its own session)" : "shares a login already on this host"}</div>
        </div>
        {canManage && (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button className="btn sm" disabled={!!busy} onClick={() => act("verify", () => send("POST", `/subs/${s.id}/verify`, {}, s.id))}>{busy === "verify" ? "Verifying…" : "Verify now"}</button>
            {s.status === "paused" ? <button className="btn sm" disabled={!!busy} onClick={() => act("resume", () => send("POST", `/subs/${s.id}/resume`, {}, s.id))}>Resume</button>
              : <button className="btn sm" disabled={!!busy || s.status !== "active"} onClick={() => act("pause", () => send("POST", `/subs/${s.id}/pause`, {}, s.id))}>Pause</button>}
            <button className="btn sm danger" disabled={!!busy} onClick={() => { if (confirm(`Detach "${s.label}"? Its agents stop and Agora deletes its copy of the login.`)) void act("detach", () => send("DELETE", `/subs/${s.id}`, undefined, s.id)); }}>Detach</button>
          </div>
        )}
      </div>
      <div className="panel-body">
        <div className="grid g-12" style={{ gap: 18 }}>
          <div className="span-4 col" style={{ gap: 10 }}>
            <div className="eyebrow">Verification</div>
            <div className="checks">
              <Row ok={!!s.email} label="Login found" value={s.email ? `${s.email}` : "—"} />
              <Row ok={!!s.plan} label="Plan" value={s.plan ?? "—"} />
              <Row ok={expiresIn == null ? false : expiresIn > 0} warn={expiresIn != null && expiresIn <= 0} label="Access token" value={expiresIn == null ? "—" : expiresIn > 0 ? `valid ${untilTs(s.token_expires_at)}` : "expired; Codex refreshes it on next use"} />
              <Row ok={!!s.verify_detail?.ok} warn={!!s.verify_detail && !s.verify_detail.ok} pending={s.status === "verifying"} label="Live round trip" value={s.verify_detail ? (s.verify_detail.ok ? `${(s.verify_detail.latency_ms / 1000).toFixed(1)}s · ${s.verify_detail.model} · "${s.verify_detail.reply}"` : s.verify_detail.error ?? "failed") : "—"} />
              <Row ok={!!rl} label="Quota reported by agents" value={rl ? `${rl.plan_type ?? ""} · checked ${ago(s.rate_checked_at)}` : "after the first session"} />
            </div>
            {s.verify_detail && <div className="tag">last check {dateTime(s.verify_detail.checked_at)} · account hash {s.account_hash}</div>}
            {s.error && <div className="banner err" style={{ fontSize: 12.5 }}>{s.error}</div>}
            {s.status === "pending_auth" && s.device && <div className="banner warn" style={{ fontSize: 12.5 }}>Waiting for sign-in{s.device.code ? <> with code <b className="mono">{s.device.code}</b></> : null}{/^https?:\/\//i.test(s.device.url ?? "") ? <> at <a className="link" href={s.device.url} target="_blank" rel="noopener noreferrer">{s.device.url.replace("https://", "")}</a></> : null}.</div>}
            {s.status === "auth_error" && <button className="btn sm primary" onClick={openAttach}>Attach again with a fresh sign-in</button>}
          </div>

          <div className="span-4 col" style={{ gap: 10 }}>
            <div className="eyebrow">Quota</div>
            <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em" }}>{rl ? `${used}%` : "—"}</span>
              <span className="dim">of the {win ? (win >= 10080 ? "weekly" : win >= 300 ? `${Math.round(win / 60)}-hour` : `${win}-minute`) : ""} window used</span>
            </div>
            <div className="meter" title={`Agora stops starting new sessions at ${s.reserve_pct}%`}>
              <i style={{ width: `${Math.min(100, used)}%`, background: used >= s.reserve_pct ? "var(--warning)" : "var(--c1)" }} />
              <span className="mark" style={{ left: `calc(${s.reserve_pct}% - 1px)` }} />
            </div>
            <div className="tag">resets {untilTs(rl?.primary?.resets_at ? rl.primary.resets_at * 1000 : null)} · new sessions stop at {s.reserve_pct}% so the owner keeps the rest</div>
            <div className="tag">spent by Agora: {compact(s.usage.tin)} in ({compact(s.usage.tcache)} cached) · {compact(s.usage.tout)} out · {compact(s.usage.treason)} reasoning over {s.usage.runs} sessions</div>
            {canManage && (
              <label className="col" style={{ gap: 4 }}>
                <span className="eyebrow">Stop new sessions at</span>
                <div className="row"><input type="range" min={5} max={100} step={5} defaultValue={s.reserve_pct} onMouseUp={(e) => patch({ reserve_pct: Number((e.target as HTMLInputElement).value) })} onTouchEnd={(e) => patch({ reserve_pct: Number((e.target as HTMLInputElement).value) })} className="grow" /><span className="mono tag">{s.reserve_pct}%</span></div>
              </label>
            )}
          </div>

          <div className="span-4 col" style={{ gap: 10 }}>
            <div className="eyebrow">Agents on this subscription</div>
            {canManage && (
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn sm icon" disabled={!!busy || s.agents_target <= 0} onClick={() => patch({ agents_target: s.agents_target - 1 })}>−</button>
                  <span className="mono" style={{ width: 28, textAlign: "center", fontWeight: 600 }}>{s.agents_target}</span>
                  <button className="btn sm icon" disabled={!!busy || s.agents_target >= 8} onClick={() => patch({ agents_target: s.agents_target + 1 })}>+</button>
                </div>
                <select className="input" style={{ height: 28 }} value={s.model} onChange={(e) => patch({ model: e.target.value })}>{[...new Set([s.model, ...MODELS])].map((m) => <option key={m}>{m}</option>)}</select>
                <select className="input" style={{ height: 28 }} value={s.effort} onChange={(e) => patch({ effort: e.target.value })}>{[...new Set([s.effort, ...EFFORTS])].map((m) => <option key={m}>{m}</option>)}</select>
              </div>
            )}
            {!canManage && <div className="tag">{s.agents_target} agents · {s.model} · {s.effort}</div>}
            <div className="col" style={{ gap: 6 }}>
              {s.agents.length === 0 && <span className="tag">No agents yet.</span>}
              {s.agents.map((a) => (
                <Link key={a.id} to={`/agents/${a.id}`} className="row" style={{ gap: 8 }}>
                  <Glyph id={a.id} size={22} live={a.status === "running"} />
                  <span className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>{a.handle}</span>
                  <Status tone={agentTone(a.status)} label={a.status} />
                  <span className="tag ellipsis grow">{agents[a.id]?.status_detail ?? a.status_detail}</span>
                </Link>
              ))}
            </div>
            <div className="tag">Model and effort changes apply to new sessions.</div>
          </div>
        </div>
        {err && <div className="banner err" style={{ marginTop: 12 }}>{err}</div>}
      </div>
    </section>
  );
}

function Row({ ok, warn, pending, label, value }: { ok: boolean; warn?: boolean; pending?: boolean; label: string; value: string }) {
  return (
    <div className="check">
      {pending ? <span className="dot live" /> : <ToneIcon tone={ok ? "ok" : warn ? "warn" : "idle"} />}
      <span>{label}</span>
      <span className="mono dim ellipsis" style={{ fontSize: 11.5, maxWidth: 230 }} title={value}>{value}</span>
    </div>
  );
}
