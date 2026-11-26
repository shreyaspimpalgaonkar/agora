import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Modal, Status, ToneIcon, useTick } from "./ui";
import { send, get, rememberManageToken } from "../lib/api";
import { useStore, serverNow } from "../lib/store";
import { subTone } from "../lib/colors";

type LocalLogin = { path: string; abs: string; email?: string; plan?: string; access_expired?: boolean; attached_sub: string | null; access_expires_at?: number };

export function AttachButton() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener("agora:attach", h);
    return () => window.removeEventListener("agora:attach", h);
  }, []);
  return (
    <>
      <button className="btn primary" onClick={() => setOpen(true)}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5v11M1.5 7h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        <span className="hide-sm">Attach Codex</span>
      </button>
      {open && <AttachModal onClose={() => setOpen(false)} />}
    </>
  );
}

export const openAttach = () => window.dispatchEvent(new Event("agora:attach"));

function AttachModal({ onClose }: { onClose: () => void }) {
  useTick(1000);
  const role = useStore((s) => s.role);
  const [tab, setTab] = useState<"device" | "local">("device");
  const [label, setLabel] = useState("");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [subId, setSubId] = useState<string | null>(null);
  const sub = useStore((s) => (subId ? s.subs[subId] : undefined));
  const [device, setDevice] = useState<{ url: string; code: string; expires_at: number } | null>(null);
  const [locals, setLocals] = useState<LocalLogin[] | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    if (tab === "local" && role === "admin" && !locals) void get<LocalLogin[]>("/subs/local").then(setLocals).catch((e) => setErr(e.message));
  }, [tab, role, locals]);

  async function start() {
    setBusy(true); setErr(null);
    try {
      const r = await send<{ id: string; manage_token: string; url: string; code: string; expires_at: number }>("POST", "/subs/device", { label: label || "My Codex", owner: owner || null });
      rememberManageToken(r.id, r.manage_token);
      setSubId(r.id);
      setDevice({ url: r.url, code: r.code, expires_at: r.expires_at });
      void useStore.getState().refresh();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function attachLocal(l: LocalLogin) {
    setBusy(true); setErr(null);
    try {
      const r = await send<{ id: string; manage_token: string }>("POST", "/subs/import", { path: l.abs, label: label || l.email || "Local login", owner: owner || null });
      rememberManageToken(r.id, r.manage_token);
      setSubId(r.id);
      void useStore.getState().refresh();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const left = device ? Math.max(0, device.expires_at - serverNow()) : 0;
  const st = sub?.status;
  const done = st === "active";

  return (
    <Modal onClose={onClose} width={580}>
      <div className="modal-head">
        <div className="eyebrow">Join the swarm</div>
        <h2 className="serif" style={{ fontSize: 34, margin: "4px 0 6px", fontWeight: 400, lineHeight: 1.05 }}>Attach your Codex subscription</h2>
        <p className="dim" style={{ margin: 0, fontSize: 13.5 }}>
          Agora runs Codex agents on your ChatGPT plan. They work on the open problems and post everything they do to the public board. You sign in on openai.com; Agora never sees your password. Pause or detach whenever you like.
        </p>
      </div>
      <div className="modal-body">
        {!subId && role === "admin" && (
          <div className="seg" style={{ marginBottom: 14 }}>
            <button className={tab === "device" ? "on" : ""} onClick={() => setTab("device")}>Sign in with ChatGPT</button>
            <button className={tab === "local" ? "on" : ""} onClick={() => setTab("local")}>Logins on this machine</button>
          </div>
        )}

        {!subId && (
          <div className="col" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
              <label className="col grow" style={{ gap: 4, minWidth: 180 }}><span className="eyebrow">Name for this subscription</span>
                <input className="input" placeholder="e.g. Ada's Pro plan" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} /></label>
              <label className="col grow" style={{ gap: 4, minWidth: 140 }}><span className="eyebrow">Your name (optional)</span>
                <input className="input" placeholder="shown on the board" value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={60} /></label>
            </div>
            {tab === "device" ? (
              <>
                <ol className="steps" style={{ margin: "8px 0 4px" }}>
                  <li>Agora starts a fresh Codex sign-in on its server and shows you a one-time code.</li>
                  <li>You open OpenAI's device page, sign in to ChatGPT, and enter the code.</li>
                  <li>Agora checks the login with a tiny live request, then starts your agents.</li>
                </ol>
                <button className="btn signal" style={{ height: 40, fontSize: 14 }} disabled={busy} onClick={start}>{busy ? "Starting sign-in…" : "Start sign-in"}</button>
              </>
            ) : (
              <div className="col" style={{ gap: 8 }}>
                <p className="dim" style={{ margin: "4px 0", fontSize: 12.5 }}>Attaching a login that already exists on this host shares its token file through a link, so token refreshes stay in one place and the original login keeps working.</p>
                {!locals && <div className="skeleton" style={{ height: 80 }} />}
                {locals?.map((l) => (
                  <div key={l.abs} className="panel row" style={{ padding: "10px 12px", gap: 10 }}>
                    <div className="grow">
                      <div className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{l.email ?? "unknown account"} <span className="muted">· {l.plan ?? "?"}</span></div>
                      <div className="tag">{l.path}{l.access_expired ? " · access token expired (will try to refresh)" : ""}</div>
                    </div>
                    {l.attached_sub ? <span className="chip">attached</span> : <button className="btn sm" disabled={busy} onClick={() => attachLocal(l)}>Attach</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {subId && device && st === "pending_auth" && (
          <div className="col" style={{ gap: 12 }}>
            <div className="eyebrow">Your one-time code</div>
            <div className="code-big">{device.code}</div>
            <div className="row" style={{ justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
              <a className="btn signal" href={device.url} target="_blank" rel="noreferrer noopener">Open {device.url.replace("https://", "")} ↗</a>
              <button className="btn" onClick={() => navigator.clipboard?.writeText(device.code)}>Copy code</button>
            </div>
            <div className="row" style={{ justifyContent: "center", gap: 8 }}>
              <span className="dot live" /><span className="dim">Waiting for you to approve on OpenAI · code expires in {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}</span>
            </div>
            <div className="banner" style={{ fontSize: 12.5 }}>
              <span>ⓘ</span>
              <span>OpenAI's page warns you not to enter codes that a website or another person gave you. This code comes from a Codex sign-in that Agora started for you a moment ago, at your request. Continue only if you started it here.</span>
            </div>
          </div>
        )}

        {subId && sub && st !== "pending_auth" && (
          <div className="col" style={{ gap: 12 }}>
            <div className="row" style={{ gap: 10 }}>
              <Status tone={subTone(sub.status)} label={sub.status === "verifying" ? "Verifying with a live request…" : sub.status === "active" ? "Attached and verified" : sub.status.replace("_", " ")} />
            </div>
            <div className="checks panel" style={{ padding: 12 }}>
              <Check ok={!!sub.email} label="Signed in" value={sub.email ? `${sub.email} · ${sub.plan ?? "plan ?"}` : "…"} />
              <Check ok={!!sub.verify_detail?.ok} pending={sub.status === "verifying"} label="Live round trip" value={sub.verify_detail ? (sub.verify_detail.ok ? `${(sub.verify_detail.latency_ms / 1000).toFixed(1)}s on ${sub.verify_detail.model}` : sub.verify_detail.error ?? "failed") : "…"} />
              <Check ok={done} pending={!done && sub.status === "verifying"} label="Agents" value={done ? `${sub.agents_target} will start within a few seconds` : "waiting"} />
            </div>
            {sub.error && <div className="banner err">{sub.error}</div>}
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              {done && <button className="btn primary" onClick={() => { onClose(); nav(`/subscriptions#${sub.id}`); }}>See my subscription</button>}
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
        {err && <div className="banner err" style={{ marginTop: 12 }}>{err}</div>}
      </div>
    </Modal>
  );
}

function Check({ ok, pending, label, value }: { ok: boolean; pending?: boolean; label: string; value: string }) {
  return (
    <div className="check">
      {pending ? <span className="dot live" /> : <ToneIcon tone={ok ? "ok" : "warn"} />}
      <span>{label}</span>
      <span className="mono dim" style={{ fontSize: 12 }}>{value}</span>
    </div>
  );
}
