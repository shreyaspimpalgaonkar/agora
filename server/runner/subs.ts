import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { one, all, run, parse, type Row } from "../db.js";
import { emit, sysEvent } from "../bus.js";
import { SUBS_DIR, DEFAULTS, CODEX_BIN, now } from "../config.js";
import { agentEnv, FEATURE_FLAGS, isRunAlive, killGroup } from "./codex.js";
import { LineTailer } from "./events.js";
import { redact } from "../security.js";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function decodeJwt(tok: string | undefined): Row | null {
  if (!tok || tok.split(".").length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString("utf8"));
  } catch { return null; }
}

export type AuthInfo = {
  ok: boolean; mode?: string; email?: string; plan?: string; account_hash?: string;
  access_expires_at?: number; last_refresh?: string; error?: string;
};

/** What is in a Codex auth.json, without ever returning the tokens themselves. */
export function readAuthInfo(file: string): AuthInfo {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (d.OPENAI_API_KEY && !d.tokens) return { ok: true, mode: "apikey", email: "API key", plan: "api" };
    const t = d.tokens ?? {};
    const id = decodeJwt(t.id_token) ?? {};
    const access = decodeJwt(t.access_token) ?? {};
    const auth = (id["https://api.openai.com/auth"] ?? access["https://api.openai.com/auth"] ?? {}) as Row;
    const acct = t.account_id ?? auth.chatgpt_account_id ?? "";
    return {
      ok: true, mode: d.auth_mode ?? "chatgpt", email: id.email ?? access["https://api.openai.com/profile"]?.email,
      plan: auth.chatgpt_plan_type, account_hash: acct ? crypto.createHash("sha256").update(acct).digest("hex").slice(0, 10) : undefined,
      access_expires_at: access.exp ? access.exp * 1000 : undefined, last_refresh: d.last_refresh,
    };
  } catch (e: any) {
    return { ok: false, error: e?.code === "ENOENT" ? "no auth.json yet" : String(e?.message ?? e) };
  }
}

export const maskEmail = (e?: string | null) => {
  if (!e || !e.includes("@")) return e ?? null;
  const [u, d] = e.split("@");
  return `${u.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}`;
};

export function subView(s: Row, admin = false) {
  const agents = all("SELECT id, handle, status, status_detail, current_run_id, enabled FROM agents WHERE sub_id=? AND status!='retired' ORDER BY slot", s.id);
  const usage = one(
    `SELECT count(*) runs, coalesce(sum(tokens_in),0) tin, coalesce(sum(tokens_out),0) tout, coalesce(sum(tokens_reasoning),0) treason, coalesce(sum(tokens_cached),0) tcache
     FROM runs WHERE sub_id=? AND kind!='probe'`, s.id,
  )!;
  const rawVerify = parse<Row | null>(s.verify_detail, null);
  const verifyDetail = rawVerify ? (() => { const { home: _h, ...rest } = rawVerify; return admin && rawVerify.home ? rawVerify : rest; })() : null;
  const rawDevice = parse<Row | null>(s.device, null);
  // Never leak the login process PID; only admins see another user's pending one-time device code.
  const device = rawDevice
    ? (admin
      ? { url: rawDevice.url, code: rawDevice.code, started_at: rawDevice.started_at, expires_at: rawDevice.expires_at }
      : { url: rawDevice.url, started_at: rawDevice.started_at, expires_at: rawDevice.expires_at })
    : null;
  return {
    id: s.id, label: s.label, owner: s.owner, source: s.source, status: s.status,
    email: admin ? s.email : maskEmail(s.email), plan: s.plan, account_hash: s.account_hash,
    token_expires_at: s.token_expires_at, agents_target: s.agents_target, model: s.model, effort: s.effort,
    reserve_pct: s.reserve_pct, rate_limits: parse(s.rate_limits, null), rate_checked_at: s.rate_checked_at,
    verified_at: s.verified_at, verify_detail: verifyDetail, device,
    paused_until: s.paused_until, error: s.error, created_at: s.created_at,
    home: admin ? s.home : undefined, source_path: admin ? s.source_path : undefined,
    agents, usage,
  };
}

export function emitSub(id: string) {
  const s = one("SELECT * FROM subscriptions WHERE id=?", id);
  if (s) emit("sub", subView(s));
}

function newSubRow(label: string, owner: string | null, source: "device" | "import", sourcePath: string | null) {
  const id = "sub_" + crypto.randomBytes(5).toString("hex");
  const home = path.join(SUBS_DIR, id, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const manage = crypto.randomBytes(16).toString("base64url");
  run(
    `INSERT INTO subscriptions(id,label,owner,source,source_path,home,status,agents_target,model,effort,reserve_pct,manage_token,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, label, owner, source, sourcePath, home, source === "device" ? "pending_auth" : "verifying",
    DEFAULTS.agentsPerSub, DEFAULTS.model, DEFAULTS.effort, DEFAULTS.reservePct, manage, now(),
  );
  return { id, home, manage };
}

/** Logins already present on this machine that an admin can attach without a new sign-in. */
export function scanLocalLogins() {
  const home = os.homedir();
  const cands = new Set<string>([path.join(home, ".codex", "auth.json")]);
  const prof = path.join(home, ".codex", "auth-profiles");
  if (fs.existsSync(prof)) for (const f of fs.readdirSync(prof)) if (f.endsWith(".json")) cands.add(path.join(prof, f));
  for (const d of fs.readdirSync(home)) if (d.startsWith(".codex-") && fs.existsSync(path.join(home, d, "auth.json"))) cands.add(path.join(home, d, "auth.json"));
  const attached = all("SELECT source_path, id, status FROM subscriptions WHERE source='import' AND status!='detached'");
  return [...cands].map((file) => {
    const info = readAuthInfo(file);
    const real = (() => { try { return fs.realpathSync(file); } catch { return file; } })();
    const att = attached.find((a) => a.source_path === file || a.source_path === real);
    return {
      path: file.replace(home, "~"), abs: file, ...info,
      access_expired: info.access_expires_at ? info.access_expires_at < now() : undefined,
      attached_sub: att?.id ?? null,
    };
  }).filter((x) => x.ok);
}

/**
 * Attach a login that already exists on this host. The subscription's auth.json is a symlink
 * to the original file, so token refreshes write back to one place and the original login
 * keeps working. (Copying the file would fork the refresh token, and the next refresh on
 * either side would sign the other one out.)
 */
export function importLocalLogin(absPath: string, label: string, owner: string | null, opts: { agents_target?: number; reserve_pct?: number } = {}) {
  const info = readAuthInfo(absPath);
  if (!info.ok) throw new Error(`cannot read ${absPath}: ${info.error}`);
  const { id, home, manage } = newSubRow(label, owner, "import", absPath);
  fs.symlinkSync(absPath, path.join(home, "auth.json"));
  run("UPDATE subscriptions SET email=?, plan=?, account_hash=?, token_expires_at=? WHERE id=?", info.email ?? null, info.plan ?? null, info.account_hash ?? null, info.access_expires_at ?? null, id);
  if (opts.agents_target !== undefined) run("UPDATE subscriptions SET agents_target=? WHERE id=?", Math.max(0, Math.min(8, opts.agents_target)), id);
  if (opts.reserve_pct !== undefined) run("UPDATE subscriptions SET reserve_pct=? WHERE id=?", Math.max(5, Math.min(100, opts.reserve_pct)), id);
  sysEvent("info", "sub.attached", `Attached local login ${maskEmail(info.email)} (${info.plan ?? "?"}) as "${label}"`, { sub_id: id });
  emitSub(id);
  void verifySub(id);
  return { id, manage_token: manage };
}

/** Start `codex login --device-auth` in a fresh CODEX_HOME and surface the code to the browser. */
export async function startDeviceLogin(label: string, owner: string | null) {
  const { id, home, manage } = newSubRow(label, owner, "device", null);
  const dir = path.dirname(home);
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const outPath = path.join(dir, "login.out");
  const out = fs.openSync(outPath, "w", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(CODEX_BIN, ["login", "--device-auth"], {
      env: { ...agentEnv(), CODEX_HOME: home, NO_COLOR: "1" }, detached: true, stdio: ["ignore", out, out],
    });
    child.unref();
  } finally {
    fs.closeSync(out);
  }
  const started = now();
  // Wait for the URL and code to appear in the login output.
  let url: string | null = null, code: string | null = null;
  for (let i = 0; i < 60 && !(url && code); i++) {
    await new Promise((r) => setTimeout(r, 250));
    const text = stripAnsi(fs.readFileSync(outPath, "utf8"));
    url = text.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0] ?? null;
    code = text.match(/\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/)?.[1] ?? null;
  }
  if (!url || !code) {
    if (child.pid && isRunAlive(child.pid, "login")) killGroup(child.pid, "SIGTERM");
    run("UPDATE subscriptions SET status='auth_error', error=? WHERE id=?", "codex login did not print a device code", id);
    emitSub(id);
    throw new Error("codex login did not print a device code");
  }
  const device = { url, code, pid: child.pid, started_at: started, expires_at: started + 15 * 60_000 };
  run("UPDATE subscriptions SET device=? WHERE id=?", JSON.stringify(device), id);
  sysEvent("info", "sub.device_started", `Device sign-in started for "${label}"`, { sub_id: id });
  emitSub(id);
  watchDeviceLogin(id);
  return { id, manage_token: manage, url, code, started_at: started, expires_at: device.expires_at };
}

const deviceWatchers = new Set<string>();
export function watchDeviceLogin(id: string) {
  if (deviceWatchers.has(id)) return;
  deviceWatchers.add(id);
  const tick = setInterval(() => {
    const s = one("SELECT * FROM subscriptions WHERE id=?", id);
    if (!s || s.status !== "pending_auth") { clearInterval(tick); deviceWatchers.delete(id); return; }
    const info = readAuthInfo(path.join(s.home, "auth.json"));
    const device = parse<Row>(s.device, {});
    if (info.ok && info.mode) {
      clearInterval(tick); deviceWatchers.delete(id);
      run("UPDATE subscriptions SET status='verifying', email=?, plan=?, account_hash=?, token_expires_at=?, device=NULL, error=NULL WHERE id=?",
        info.email ?? null, info.plan ?? null, info.account_hash ?? null, info.access_expires_at ?? null, id);
      sysEvent("ok", "sub.signed_in", `Signed in: ${maskEmail(info.email)} (${info.plan ?? "?"})`, { sub_id: id });
      emitSub(id);
      void verifySub(id);
    } else if (device.expires_at && now() > device.expires_at + 10_000) {
      clearInterval(tick); deviceWatchers.delete(id);
      if (device.pid && isRunAlive(device.pid, "login")) killGroup(device.pid, "SIGTERM");
      run("UPDATE subscriptions SET status='auth_error', error='device code expired before sign-in finished' WHERE id=?", id);
      sysEvent("warn", "sub.device_expired", `Device code for "${s.label}" expired`, { sub_id: id });
      emitSub(id);
    }
  }, 2000);
  tick.unref();
}

/** Newest rate-limit snapshot from a codex rollout file (`token_count` events). */
export function readRollout(file: string, offset: number) {
  const t = new LineTailer(file, offset);
  let rate: Row | null = null, usage: Row | null = null;
  for (const line of t.read()) {
    if (!line.includes('"token_count"')) continue;
    try {
      const d = JSON.parse(line);
      const p = d.payload ?? {};
      if (p.type !== "token_count") continue;
      if (p.rate_limits) rate = p.rate_limits;
      if (p.info?.total_token_usage) usage = p.info.total_token_usage;
    } catch { /* partial line */ }
  }
  return { rate, usage, offset: t.committed };
}

export function findRollout(home: string, threadId: string): string | null {
  const root = path.join(home, "sessions");
  if (!fs.existsSync(root)) return null;
  const walk = (d: string, depth: number): string | null => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    ents.sort((a, b) => (a.name < b.name ? 1 : -1)); // newest dates first
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) { const r = walk(p, depth + 1); if (r) return r; }
      else if (e.isFile() && e.name.endsWith(`${threadId}.jsonl`)) return p;
    }
    return null;
  };
  return walk(root, 0);
}

export function applyRateLimits(subId: string, rate: Row) {
  run("UPDATE subscriptions SET rate_limits=?, rate_checked_at=? WHERE id=?", JSON.stringify(rate), now(), subId);
  if (rate.plan_type) run("UPDATE subscriptions SET plan=coalesce(plan, ?) WHERE id=?", rate.plan_type, subId);
  emitSub(subId);
}

/**
 * Prove a subscription works end to end: a tiny `codex exec` on the cheapest model, under this
 * subscription's CODEX_HOME. Records latency, the reply, the plan reported by the server, and
 * the quota snapshot. This is the "instantiated correctly" check the UI shows per subscription.
 */
export async function verifySub(id: string): Promise<boolean> {
  const s = one("SELECT * FROM subscriptions WHERE id=?", id);
  if (!s) return false;
  const prev = s.status;
  if (prev !== "active") run("UPDATE subscriptions SET status='verifying' WHERE id=?", id);
  emitSub(id);
  const dir = path.join(path.dirname(s.home), "probe");
  fs.mkdirSync(dir, { recursive: true });
  const t0 = now();
  const nonce = crypto.randomBytes(3).toString("hex").toUpperCase();
  const args = ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-C", dir, "-s", "read-only", "-m", DEFAULTS.probeModel,
    "-c", 'model_reasoning_effort="low"', ...FEATURE_FLAGS, `Reply with exactly AGORA-${nonce} and nothing else.`];
  const res = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(CODEX_BIN, args, { env: { ...agentEnv(), CODEX_HOME: s.home }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code) => { clearTimeout(killer); resolve({ code, out, err }); });
  });
  const latency = now() - t0;
  const msgs = res.out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const reply = msgs.find((m: Row) => m.item?.type === "agent_message")?.item?.text ?? "";
  const failure = msgs.find((m: Row) => m.type === "turn.failed" || m.type === "error");
  const thread = msgs.find((m: Row) => m.type === "thread.started")?.thread_id;
  // --ephemeral runs do not write a rollout, so quota comes from the newest rollout of a real run, if any.
  const info = readAuthInfo(path.join(s.home, "auth.json"));
  const ok = res.code === 0 && reply.includes(`AGORA-${nonce}`);
  const rawErr = ok ? null : (failure?.error?.message ?? failure?.message ?? res.err.split("\n").filter((l) => /error/i.test(l)).slice(-1)[0] ?? `exit ${res.code}`);
  const detail = {
    ok, latency_ms: latency, model: DEFAULTS.probeModel, reply: redact(reply).slice(0, 80), expected: `AGORA-${nonce}`, thread,
    error: rawErr ? redact(String(rawErr)).slice(0, 500) : null,
    email: maskEmail(info.email), plan: info.plan, account_hash: info.account_hash, checked_at: now(),
    access_expires_at: info.access_expires_at,
  };
  if (ok) {
    const keepPaused = prev === "paused";
    run("UPDATE subscriptions SET status=?, verified_at=?, verify_detail=?, error=NULL, email=coalesce(?,email), plan=coalesce(?,plan), account_hash=coalesce(?,account_hash), token_expires_at=? WHERE id=?",
      keepPaused ? "paused" : "active", now(), JSON.stringify(detail), info.email ?? null, info.plan ?? null, info.account_hash ?? null, info.access_expires_at ?? null, id);
    sysEvent("ok", "sub.verified", `"${s.label}" verified: ${maskEmail(info.email)} · ${info.plan ?? "?"} · round trip ${(latency / 1000).toFixed(1)}s`, { sub_id: id }, detail);
  } else {
    const kind = /refresh|sign in|401|unauthorized|log out/i.test(String(detail.error)) ? "auth_error" : prev === "active" ? "active" : "auth_error";
    run("UPDATE subscriptions SET status=?, verify_detail=?, error=? WHERE id=?", kind, JSON.stringify(detail), String(detail.error).slice(0, 500), id);
    sysEvent("error", "sub.verify_failed", `"${s.label}" failed verification: ${detail.error}`, { sub_id: id }, detail);
  }
  emitSub(id);
  return ok;
}
