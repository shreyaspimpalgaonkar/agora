import express, { type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import { one, all, run, parse, kvGet, type Row } from "./db.js";
import { emit, attachStream, sysEvent, streamCount, poll } from "./bus.js";
import { ALLOWED_EFFORTS, DATA_DIR, DEFAULTS, KEYS, MODEL_RE, ROOT, RUNS_DIR, now } from "./config.js";
import * as board from "./board.js";
import { supervisor, agentView, runView } from "./runner/supervisor.js";
import { subView, emitSub, scanLocalLogins, importLocalLogin, startDeviceLogin, verifySub } from "./runner/subs.js";
import { isRunAlive, killGroup } from "./runner/codex.js";
import {
  clampInt,
  createRateLimiter,
  createRedactStream,
  parsePosInt,
  redact,
  resolveSafeFile,
  safeEqual,
  safeFilename,
} from "./security.js";

export const api = express.Router();
api.use(express.json({ limit: "4mb" }));

const HUB_STARTED = now();
let outageUntil = 0;

const AGENT_POST_KINDS = new Set([
  "plan", "idea", "lemma", "computation", "literature", "dead_end", "question", "answer", "note", "handoff",
]);
const AGENT_POST_CHANNELS = new Set(["general", "coordination", "results"]);
const AGENT_FEED_CHANNELS = new Set(["all", "general", "coordination", "results", "reviews"]);
const SYS_LEVELS = new Set(["info", "ok", "warn", "error"]);

const authFailLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 30 });
const deviceLoginLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });

function clientIp(req: Request): string {
  return req.socket.remoteAddress ?? "unknown";
}

function isHttps(req: Request): boolean {
  if (req.secure) return true;
  const xf = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  return xf === "https";
}

// CSRF defense-in-depth for cookie-authenticated browser mutations (exempt agent token API).
api.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (req.path.startsWith("/agent/")) return next();
  const fetchSite = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (fetchSite === "cross-site") {
    return res.status(403).json({ error: "cross-site request blocked" });
  }
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return res.status(403).json({ error: "origin mismatch" });
      }
    } catch {
      return res.status(403).json({ error: "invalid origin" });
    }
  }
  next();
});

// ---------- auth ----------

type Role = "admin" | "viewer" | null;
function roleOf(req: Request): Role {
  const headerKey = typeof req.headers["x-agora-key"] === "string" ? req.headers["x-agora-key"] : undefined;
  const cookieKey = typeof req.cookies?.agora_key === "string" ? req.cookies.agora_key : undefined;
  const key = headerKey || cookieKey;
  if (!key) return null;
  if (safeEqual(key, KEYS.admin)) return "admin";
  if (safeEqual(key, KEYS.viewer)) return "viewer";
  return null;
}

const need = (min: "viewer" | "admin") => (req: Request, res: Response, next: NextFunction) => {
  const ip = clientIp(req);
  const blocked = authFailLimiter.isBlocked(ip);
  if (blocked.blocked) {
    res.setHeader("Retry-After", String(blocked.retryAfterSec));
    return res.status(429).json({ error: "too many failed authentication attempts" });
  }
  const r = roleOf(req);
  if (r === "admin" || (min === "viewer" && r === "viewer")) return next();
  // Rate-limit bad keys (don't penalize an unauthenticated initial /api/state check with no key).
  if (req.headers["x-agora-key"] || req.cookies?.agora_key) {
    authFailLimiter.consume(ip);
  }
  res.status(r ? 403 : 401).json({ error: r ? "admin key required" : "access key required" });
};

/** Admin, or the volunteer who attached this subscription (they hold its manage token). */
function canManage(req: Request, subId: string): { ok: boolean; rateLimited?: number } {
  const ip = clientIp(req);
  const blocked = authFailLimiter.isBlocked(ip);
  if (blocked.blocked) return { ok: false, rateLimited: blocked.retryAfterSec };
  if (roleOf(req) === "admin") return { ok: true };
  const tok = typeof req.headers["x-agora-manage"] === "string" ? req.headers["x-agora-manage"] : undefined;
  if (!tok) return { ok: false };
  const row = one<{ manage_token: string | null }>("SELECT manage_token FROM subscriptions WHERE id=?", subId);
  if (row?.manage_token && safeEqual(tok, row.manage_token)) return { ok: true };
  authFailLimiter.consume(ip);
  return { ok: false };
}

function setKeyCookie(req: Request, res: Response, key: string) {
  const secureFlag = isHttps(req) ? "; Secure" : "";
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", `agora_key=${encodeURIComponent(key)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; HttpOnly; SameSite=Lax${secureFlag}`);
}

api.post("/auth/login", (req, res) => {
  const ip = clientIp(req);
  const blocked = authFailLimiter.isBlocked(ip);
  if (blocked.blocked) {
    res.setHeader("Retry-After", String(blocked.retryAfterSec));
    return res.status(429).json({ error: "too many attempts; try again later" });
  }
  const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  if (safeEqual(key, KEYS.admin)) {
    setKeyCookie(req, res, KEYS.admin);
    return res.json({ role: "admin" });
  }
  if (safeEqual(key, KEYS.viewer)) {
    setKeyCookie(req, res, KEYS.viewer);
    return res.json({ role: "viewer" });
  }
  authFailLimiter.consume(ip);
  return res.status(401).json({ error: "invalid access key" });
});

api.post("/auth/logout", (req, res) => {
  const secureFlag = isHttps(req) ? "; Secure" : "";
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Set-Cookie", `agora_key=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureFlag}`);
  return res.json({ ok: true });
});

const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e: any) {
    if (!res.headersSent) res.status(400).json({ error: e?.message ?? String(e) });
  }
};

// ---------- agent API (called by the board MCP server inside each codex process) ----------

type Ctx = { run: Row; agent: Row };
function agentCtx(req: Request): Ctx {
  const token = typeof req.headers["x-agora-token"] === "string" ? req.headers["x-agora-token"] : undefined;
  if (!token || token.length < 16 || token.length > 128) {
    throw Object.assign(new Error("unknown run token"), { status: 401 });
  }
  const r = one("SELECT * FROM runs WHERE token=?", token);
  if (!r || !safeEqual(token, r.token)) throw Object.assign(new Error("unknown run token"), { status: 401 });
  const a = one("SELECT * FROM agents WHERE id=?", r.agent_id)!;
  return { run: r, agent: a };
}

const ago = (ts: number) => {
  const m = Math.round((now() - ts) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${(m / 60).toFixed(1)} h ago`;
};
function fmtPost(p: ReturnType<typeof board.postView>) {
  const head = [`[#p${p.id}]`, p.author, p.kind, p.title ? `"${p.title}"` : null, ago(p.ts), p.parent_id ? `reply to #p${p.parent_id}` : null, p.to ? `to @${p.to}` : null]
    .filter(Boolean).join(" · ");
  return `${head}\n${p.body}`;
}
const fmtPosts = (ps: ReturnType<typeof board.postView>[], empty: string) => (ps.length ? ps.map(fmtPost).join("\n\n---\n\n") : empty);

const agentTools: Record<string, (ctx: Ctx, b: Row) => { text: string; [k: string]: unknown }> = {
  board_whoami(ctx) {
    const { run: r, agent: a } = ctx;
    const s = one("SELECT label, plan FROM subscriptions WHERE id=?", r.sub_id)!;
    const p = one("SELECT id, title FROM problems WHERE id=?", r.problem_id);
    const others = all("SELECT a.handle, l.role FROM leases l JOIN agents a ON a.id=l.agent_id WHERE l.problem_id=? AND l.released_at IS NULL AND l.agent_id!=?", r.problem_id, a.id);
    const used = Math.round((now() - r.started_at) / 60000);
    return {
      text: [
        `You are @${a.handle}, an Agora agent running on the subscription "${s.label}" (${s.plan ?? "plan unknown"}), model ${r.model} (${r.effort}).`,
        r.kind === "review"
          ? `Assignment: review submission S${r.submission_id} on problem #${p?.id} "${p?.title}".`
          : `Assignment: problem #${p?.id} "${p?.title}" as ${r.role}.`,
        `Time used: ${used} min of a ~${DEFAULTS.runBudgetMin} min budget.`,
        others.length ? `Also on this problem right now: ${others.map((o) => `@${o.handle} (${o.role})`).join(", ")}.` : "No other agent is on this problem right now.",
      ].join("\n"),
    };
  },
  board_read_thread(ctx, b) {
    const pid = parsePosInt(b.problem_id);
    if (!pid) throw new Error("invalid problem_id");
    const p = one("SELECT title, state, attempts FROM problems WHERE id=?", pid);
    if (!p) throw new Error(`problem ${pid} does not exist`);
    const posts = board.readThread(pid, clampInt(b.since_id, 0, Number.MAX_SAFE_INTEGER, 0));
    board.recordRead(ctx.agent.id, ctx.run.id, `thread:${pid}`, posts.map((x) => x.id));
    return { text: `Thread for #${pid} "${p.title}" (state ${p.state}, ${p.attempts} attempt(s)), ${posts.length} post(s):\n\n${fmtPosts(posts, "(no posts yet: you are the first one here)")}` };
  },
  board_read_feed(ctx, b) {
    const ch = b.channel ? String(b.channel) : "all";
    if (!AGENT_FEED_CHANNELS.has(ch)) throw new Error(`invalid channel: ${ch}`);
    const posts = board.readFeed(ch, clampInt(b.limit, 1, 60, 30), clampInt(b.since_id, 0, Number.MAX_SAFE_INTEGER, 0));
    board.recordRead(ctx.agent.id, ctx.run.id, `feed:${ch}`, posts.map((p) => p.id));
    return { text: fmtPosts(posts, "(the board is empty so far)") };
  },
  board_post(ctx, b) {
    const problemId = b.problem_id !== undefined && b.problem_id !== null ? parsePosInt(b.problem_id) : null;
    if (b.problem_id !== undefined && b.problem_id !== null && !problemId) throw new Error("invalid problem_id");
    const replyTo = b.reply_to !== undefined && b.reply_to !== null ? parsePosInt(b.reply_to) : null;
    if (b.reply_to !== undefined && b.reply_to !== null && !replyTo) throw new Error("invalid reply_to");
    const kind = String(b.kind ?? "note");
    if (!AGENT_POST_KINDS.has(kind)) throw new Error(`invalid post kind: ${kind}`);
    const requestedChannel = b.channel ? String(b.channel) : "general";
    if (!problemId && !replyTo && !AGENT_POST_CHANNELS.has(requestedChannel)) {
      throw new Error(`invalid channel: ${requestedChannel}`);
    }
    const channel = problemId || replyTo ? "problem" : requestedChannel;
    const p = board.createPost({
      channel, problem_id: problemId, parent_id: replyTo,
      author_type: "agent", agent_id: ctx.agent.id, run_id: ctx.run.id, kind, title: b.title ? String(b.title) : null, body: String(b.body ?? ""),
    });
    return { text: `Posted #p${p.id} to ${p.problem_id ? `the #${p.problem_id} thread` : "#" + p.channel}.${p.mentions.length ? ` Mentioned: ${p.mentions.map((m) => "@" + m).join(", ")}.` : ""}`, id: p.id };
  },
  board_inbox(ctx) {
    const posts = board.inbox(ctx.agent.id);
    board.recordRead(ctx.agent.id, ctx.run.id, "inbox", posts.map((p) => p.id));
    return { text: posts.length ? `${posts.length} new item(s):\n\n${fmtPosts(posts, "")}` : "Inbox is empty: nothing new for you." };
  },
  board_search(ctx, b) {
    const query = String(b.query ?? "").trim().slice(0, 200);
    if (query.length < 1) throw new Error("query is required");
    const posts = board.searchPosts(query, clampInt(b.limit, 1, 40, 15));
    board.recordRead(ctx.agent.id, ctx.run.id, `search:${query.slice(0, 40)}`, posts.map((p) => p.id));
    const probs = all("SELECT id, title FROM problems WHERE title LIKE ? OR statement LIKE ? LIMIT 8", `%${query}%`, `%${query}%`);
    return { text: `${probs.length ? "Problems:\n" + probs.map((p) => `- #${p.id} ${p.title}`).join("\n") + "\n\n" : ""}Posts:\n\n${fmtPosts(posts, "(no matching posts)")}` };
  },
  board_get_problem(ctx, b) {
    const pid = parsePosInt(b.problem_id);
    if (!pid) throw new Error("invalid problem_id");
    const p = one("SELECT * FROM problems WHERE id=?", pid);
    if (!p) throw new Error(`problem ${pid} does not exist`);
    const v = board.problemView(p, true) as Row;
    board.recordRead(ctx.agent.id, ctx.run.id, `problem:${p.id}`, []);
    const subs = (v.submissions ?? []).slice(0, 5).map((s: Row) => `- S${s.id} @${s.handle}: ${s.outcome} (${s.review_state}). ${s.summary.slice(0, 300)}`).join("\n");
    return {
      text: `#${p.id} ${p.title}\nDomain: ${p.domain_label}\nState on Agora: ${p.state}, ${p.attempts} attempt(s), ${p.posts} post(s). Active now: ${v.active.map((x: Row) => "@" + x.handle).join(", ") || "nobody"}.\n\nExact target: ${p.statement}\n\nStatus note: ${p.atlas_note ?? "open"}\n\nSources:\n${(v.sources ?? []).map((s: Row) => `- ${s.citation} ${s.url ?? ""}`).join("\n")}${subs ? `\n\nSubmissions:\n${subs}` : ""}`,
    };
  },
  board_list_problems(_ctx, b) {
    const where: string[] = []; const args: unknown[] = [];
    if (b.query) { const q = String(b.query).slice(0, 200); where.push("(title LIKE ? OR statement LIKE ?)"); args.push(`%${q}%`, `%${q}%`); }
    if (b.domain) { where.push("domain=?"); args.push(String(b.domain).slice(0, 40)); }
    if (b.state) { where.push("state=?"); args.push(String(b.state).slice(0, 40)); }
    const limit = clampInt(b.limit, 1, 50, 25);
    const rows = all(`SELECT id, title, domain, state, attempts FROM problems ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id LIMIT ?`, ...args, limit);
    return { text: rows.map((r) => `#${r.id} [${r.domain}] ${r.title} · ${r.state}, ${r.attempts} attempt(s)`).join("\n") || "(none)" };
  },
  board_status(ctx, b) {
    const text = redact(String(b.text ?? "")).trim().slice(0, 160);
    run("UPDATE agents SET now_text=?, last_active_at=? WHERE id=?", text, now(), ctx.agent.id);
    emit("agent", agentView(one("SELECT * FROM agents WHERE id=?", ctx.agent.id)!));
    emit("status", { agent_id: ctx.agent.id, handle: ctx.agent.handle, run_id: ctx.run.id, text, ts: now() });
    return { text: "Status updated." };
  },
  board_message(ctx, b) {
    const to = board.agentByHandle(String(b.to ?? ""));
    if (!to) throw new Error(`no agent called ${b.to}; see board_read_feed for handles`);
    const p = board.createPost({ channel: "dm", author_type: "agent", agent_id: ctx.agent.id, run_id: ctx.run.id, kind: "message", body: String(b.body ?? ""), to_agent_id: to.id });
    return { text: `Message #p${p.id} delivered to @${to.handle}'s inbox.` };
  },
  board_submit(ctx, b) {
    if (ctx.run.kind !== "attempt") throw new Error("this session is a review; use board_review");
    const out = board.submit(ctx.agent.id, ctx.run.id, ctx.run.problem_id, String(b.outcome ?? ""), String(b.summary ?? ""), String(b.writeup ?? ""), b.handoff ? String(b.handoff) : null);
    return { text: `Filed S${out.submission_id} (${b.outcome}).${out.reviews_needed ? ` It now needs ${out.reviews_needed} independent review(s); other agents will be assigned.` : ""} You can end your turn now.`, ...out };
  },
  board_get_submission(ctx, b) {
    const sid = parsePosInt(b.submission_id);
    if (!sid) throw new Error("invalid submission_id");
    const s = one("SELECT s.*, a.handle FROM submissions s JOIN agents a ON a.id=s.agent_id WHERE s.id=?", sid);
    if (!s) throw new Error(`submission S${sid} does not exist`);
    const reviews = all("SELECT r.*, a.handle FROM reviews r JOIN agents a ON a.id=r.agent_id WHERE submission_id=?", s.id);
    board.recordRead(ctx.agent.id, ctx.run.id, `submission:${s.id}`, s.post_id ? [s.post_id] : []);
    return {
      text: `S${s.id} on #${s.problem_id} by @${s.handle} · outcome ${s.outcome} · review state ${s.review_state}\n\nSummary:\n${s.summary}\n\nWrite-up:\n${s.writeup}\n\n${s.handoff ? `Handoff:\n${s.handoff}\n\n` : ""}Reviews so far:\n${reviews.map((r) => `- @${r.handle}: ${r.verdict}. ${r.body.slice(0, 600)}`).join("\n") || "(none)"}`,
    };
  },
  board_review(ctx, b) {
    const sid = parsePosInt(b.submission_id);
    if (!sid) throw new Error("invalid submission_id");
    const out = board.review(ctx.agent.id, ctx.run.id, sid, String(b.verdict ?? ""), String(b.body ?? ""));
    return { text: `Review filed. S${sid} is now ${out.review_state} (${out.accepts} accept, ${out.rejects} other). You can end your turn now.`, ...out };
  },
};

api.post("/agent/:tool", (req, res) => {
  if (now() < outageUntil) return res.status(503).json({ error: "board outage (chaos test)" });
  let ctx: Ctx;
  try { ctx = agentCtx(req); } catch (e: any) { return res.status(401).json({ error: e.message }); }
  const fn = Object.prototype.hasOwnProperty.call(agentTools, req.params.tool) ? agentTools[req.params.tool] : undefined;
  if (!fn) return res.status(404).json({ error: `unknown tool ${req.params.tool}` });
  if (["completed", "failed", "interrupted", "timeout", "killed"].includes(ctx.run.state)) {
    return res.status(409).json({ error: "this run has already ended" });
  }
  board.renewLease(ctx.run.id);
  run("UPDATE agents SET last_active_at=? WHERE id=?", now(), ctx.agent.id);
  try {
    res.json(fn(ctx, req.body ?? {}));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});

// ---------- UI API ----------

api.get("/me", (req, res) => res.json({ role: roleOf(req) }));

api.get("/state", need("viewer"), wrap((req) => {
  const admin = roleOf(req) === "admin";
  return {
    role: roleOf(req),
    dataset: kvGet("dataset", {}),
    stats: board.boardStats(),
    subs: all("SELECT * FROM subscriptions WHERE status!='detached' ORDER BY created_at").map((s) => subView(s, admin)),
    agents: all("SELECT * FROM agents WHERE status!='retired' ORDER BY created_at").map(agentView),
    runs: all("SELECT * FROM runs WHERE state NOT IN ('completed','failed','interrupted','timeout','killed') ORDER BY started_at").map(runView),
    hub: { started_at: HUB_STARTED, pid: process.pid, streams: streamCount(), loops: supervisor.loops.size, now: now() },
    defaults: DEFAULTS,
  };
}));

api.get("/problems", need("viewer"), wrap(() => all("SELECT * FROM problems ORDER BY id").map((p) => board.problemView(p))));
api.get("/problems/:id", need("viewer"), wrap((req) => {
  const pid = parsePosInt(req.params.id);
  if (!pid) throw new Error("not found");
  const p = one("SELECT * FROM problems WHERE id=?", pid);
  if (!p) throw new Error("not found");
  return { ...board.problemView(p, true), thread: board.readThread(p.id, 0, 500) };
}));
api.get("/excluded", need("viewer"), wrap(() => all("SELECT * FROM excluded_problems ORDER BY id").map((x) => ({ ...x, meta: parse(x.meta, {}) }))));

api.get("/posts", need("viewer"), wrap((req) => {
  const q = req.query as Record<string, string>;
  const where: string[] = []; const args: unknown[] = [];
  if (q.channel) { where.push("channel=?"); args.push(q.channel); }
  if (q.problem) {
    const pid = parsePosInt(q.problem);
    if (!pid) return [];
    where.push("problem_id=?"); args.push(pid);
  }
  if (q.agent) { where.push("(agent_id=? OR to_agent_id=?)"); args.push(q.agent, q.agent); }
  if (q.kind) { where.push("kind=?"); args.push(q.kind); }
  if (q.author_type) { where.push("author_type=?"); args.push(q.author_type); }
  if (q.before) {
    const before = parsePosInt(q.before);
    if (before) { where.push("id<?"); args.push(before); }
  }
  if (q.after) {
    const after = clampInt(q.after, 0, Number.MAX_SAFE_INTEGER, 0);
    where.push("id>?"); args.push(after);
  }
  if (q.q) {
    const hits = board.searchPosts(q.q, 200).map((p) => p.id);
    if (!hits.length) return [];
    where.push(`id IN (${hits.map(() => "?").join(",")})`);
    args.push(...hits);
  }
  const limit = clampInt(q.limit, 1, 500, 100);
  const rows = all(`SELECT * FROM posts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...args, limit);
  return rows.map(board.postView);
}));
api.get("/posts/:id", need("viewer"), wrap((req) => {
  const id = parsePosInt(req.params.id);
  if (!id) throw new Error("not found");
  const p = one("SELECT * FROM posts WHERE id=?", id);
  if (!p) throw new Error("not found");
  return { post: board.postView(p), replies: all("SELECT * FROM posts WHERE parent_id=? ORDER BY id", p.id).map(board.postView) };
}));
api.post("/posts", need("admin"), wrap((req) => {
  const b = req.body ?? {};
  const problemId = b.problem_id !== undefined && b.problem_id !== null ? parsePosInt(b.problem_id) : null;
  if (b.problem_id !== undefined && b.problem_id !== null && !problemId) throw new Error("invalid problem_id");
  const replyTo = b.reply_to !== undefined && b.reply_to !== null ? parsePosInt(b.reply_to) : null;
  if (b.reply_to !== undefined && b.reply_to !== null && !replyTo) throw new Error("invalid reply_to");
  return board.createPost({
    channel: problemId ? "problem" : String(b.channel ?? "general"),
    problem_id: problemId,
    parent_id: replyTo,
    author_type: "human",
    author_name: String(b.author ?? "operator").trim().slice(0, 60) || "operator",
    kind: String(b.kind ?? "announcement"),
    title: b.title ? String(b.title) : null,
    body: String(b.body ?? ""),
  });
}));
/** Read receipts: which agents pulled each post through a board tool, and when (first time). */
api.get("/reads", need("viewer"), wrap((req) => {
  const ids = String(req.query.posts ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, 600);
  if (!ids.length) return {};
  const placeholders = ids.map(() => "?").join(",");
  const rows = all(
    `SELECT CAST(j.value AS INTEGER) post_id, r.agent_id, a.handle, min(r.ts) ts FROM reads r JOIN agents a ON a.id=r.agent_id, json_each(r.post_ids) j
     WHERE CAST(j.value AS INTEGER) IN (${placeholders}) GROUP BY j.value, r.agent_id ORDER BY ts`,
    ...ids,
  );
  const out: Record<number, { agent_id: string; handle: string; ts: number }[]> = {};
  for (const r of rows) (out[r.post_id] ??= []).push({ agent_id: r.agent_id, handle: r.handle, ts: r.ts });
  return out;
}));
api.get("/channels", need("viewer"), wrap(() => ({
  channels: all("SELECT channel, count(*) n, max(id) last_id, max(ts) last_ts FROM posts WHERE channel!='problem' GROUP BY channel"),
  threads: all(`SELECT p.problem_id, pr.title, pr.domain, pr.state, count(*) n, max(p.id) last_id, max(p.ts) last_ts, count(DISTINCT p.agent_id) agents
                FROM posts p JOIN problems pr ON pr.id=p.problem_id WHERE p.channel='problem' GROUP BY p.problem_id ORDER BY last_ts DESC`),
})));

api.get("/agents", need("viewer"), wrap((req) => all(`SELECT * FROM agents ${req.query.all ? "" : "WHERE status!='retired'"} ORDER BY created_at`).map(agentView)));
api.get("/agents/:id", need("viewer"), wrap((req) => {
  const a = one("SELECT * FROM agents WHERE id=? OR upper(handle)=upper(?)", req.params.id, req.params.id);
  if (!a) throw new Error("not found");
  const runs = all("SELECT * FROM runs WHERE agent_id=? ORDER BY started_at DESC LIMIT 200", a.id).map(runView);
  const posts = all("SELECT * FROM posts WHERE agent_id=? OR to_agent_id=? ORDER BY id DESC LIMIT 300", a.id, a.id).map(board.postView);
  const sub = one("SELECT * FROM subscriptions WHERE id=?", a.sub_id);
  const events = all("SELECT * FROM sys_events WHERE agent_id=? ORDER BY id DESC LIMIT 200", a.id).map((e) => ({ ...e, data: parse(e.data, {}) }));
  const reads = all("SELECT ts, target, post_ids FROM reads WHERE agent_id=? ORDER BY id DESC LIMIT 300", a.id).map((r) => ({ ...r, post_ids: parse<number[]>(r.post_ids, []) }));
  return { agent: agentView(a), sub: sub ? subView(sub, roleOf(req) === "admin") : null, runs, posts, events, reads, interactions: interactionsFor(a.id) };
}));
api.post("/agents/:id/:action", need("admin"), wrap((req) => {
  const a = one("SELECT * FROM agents WHERE id=?", req.params.id);
  if (!a) throw new Error("not found");
  switch (req.params.action) {
    case "pause": run("UPDATE agents SET paused=1 WHERE id=?", a.id); sysEvent("info", "agent.paused", `${a.handle} paused by operator`, { agent_id: a.id }); break;
    case "resume": run("UPDATE agents SET paused=0 WHERE id=?", a.id); sysEvent("info", "agent.resumed", `${a.handle} resumed by operator`, { agent_id: a.id }); break;
    case "stop": if (a.current_run_id) supervisor.stopRun(a.current_run_id); break;
    case "kill": return supervisor.chaosKill(a.id) ?? { error: "no live process" };
    default: throw new Error("unknown action");
  }
  emit("agent", agentView(one("SELECT * FROM agents WHERE id=?", a.id)!));
  return { ok: true };
}));

function sanitizeLaunchPath(value: string): string {
  return value
    .replaceAll(DATA_DIR, ".data")
    .replaceAll(ROOT, ".")
    .replaceAll(path.dirname(process.execPath), "<node-bin>");
}

api.get("/runs", need("viewer"), wrap((req) => {
  const q = req.query as Record<string, string>;
  const where: string[] = []; const args: unknown[] = [];
  if (q.agent) { where.push("agent_id=?"); args.push(q.agent); }
  if (q.problem) {
    const pid = parsePosInt(q.problem);
    if (!pid) return [];
    where.push("problem_id=?"); args.push(pid);
  }
  if (q.active) where.push("state NOT IN ('completed','failed','interrupted','timeout','killed')");
  const limit = clampInt(q.limit, 1, 500, 100);
  return all(`SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY started_at DESC LIMIT ?`, ...args, limit).map(runView);
}));
api.get("/runs/:id", need("viewer"), wrap((req) => {
  const admin = roleOf(req) === "admin";
  const r = one("SELECT * FROM runs WHERE id=?", req.params.id);
  if (!r) throw new Error("not found");
  const files = fs.existsSync(r.dir) ? fs.readdirSync(r.dir) : [];
  const prompts = files
    .filter((f) => f.startsWith("prompt-"))
    .sort()
    .map((f) => {
      const safe = resolveSafeFile(r.dir, path.join(r.dir, f));
      return safe ? { file: f, text: redact(fs.readFileSync(safe, "utf8")) } : null;
    })
    .filter(Boolean);
  const launches = files
    .filter((f) => f.startsWith("launch-"))
    .sort()
    .map((f) => {
      const safe = resolveSafeFile(r.dir, path.join(r.dir, f));
      if (!safe) return null;
      const obj = parse<Row>(fs.readFileSync(safe, "utf8"), {});
      if (admin) return obj;
      return {
        ...obj,
        codex_home: typeof obj.codex_home === "string" ? sanitizeLaunchPath(obj.codex_home) : undefined,
        argv: Array.isArray(obj.argv) ? obj.argv.map((a: unknown) => (typeof a === "string" ? redact(sanitizeLaunchPath(a)) : a)) : [],
      };
    })
    .filter(Boolean);
  const workDir = path.join(r.dir, "work");
  // List regular files only (never expose symlinks or directories).
  const work = fs.existsSync(workDir)
    ? fs.readdirSync(workDir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).slice(0, 100)
    : [];
  return { run: runView(r), prompts, launches, work, submission: one("SELECT * FROM submissions WHERE run_id=?", r.id) ?? null, review: one("SELECT * FROM reviews WHERE run_id=?", r.id) ?? null };
}));
api.get("/runs/:id/events", need("viewer"), wrap((req) => {
  const after = clampInt(req.query.after, 0, Number.MAX_SAFE_INTEGER, 0);
  return all("SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 2000", req.params.id, after)
    .map((e) => ({ run_id: e.run_id, seq: e.seq, ts: e.ts, kind: e.kind, item_id: e.item_id, status: e.status, data: parse(e.data, {}) }));
}));
api.get("/runs/:id/raw", need("viewer"), (req, res) => {
  const r = one("SELECT id, dir FROM runs WHERE id=?", req.params.id);
  if (!r) return res.status(404).end();
  const safe = resolveSafeFile(RUNS_DIR, path.join(r.dir, "events.jsonl"));
  if (!safe) return res.status(404).end();
  const fname = safeFilename(`${r.id}.jsonl`, "events.jsonl");
  res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-disposition", `attachment; filename="${fname}"`);
  fs.createReadStream(safe, "utf8")
    .on("error", () => { if (!res.headersSent) res.status(404).end(); else res.end(); })
    .pipe(createRedactStream())
    .pipe(res);
});
api.get("/runs/:id/work/:file", need("viewer"), (req, res) => {
  const rawName = String(req.params.file ?? "");
  if (!rawName || rawName === "." || rawName === ".." || rawName.includes("/") || rawName.includes("\\") || rawName.includes("\0")) {
    return res.status(400).end();
  }
  const r = one("SELECT dir FROM runs WHERE id=?", req.params.id);
  if (!r) return res.status(404).end();
  const workDir = path.join(r.dir, "work");
  const safe = resolveSafeFile(workDir, path.join(workDir, rawName));
  if (!safe) return res.status(404).end();
  const fname = safeFilename(rawName, "file.txt");
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-disposition", `inline; filename="${fname}"`);
  fs.createReadStream(safe, "utf8")
    .on("error", () => { if (!res.headersSent) res.status(404).end(); else res.end(); })
    .pipe(createRedactStream())
    .pipe(res);
});

api.get("/submissions", need("viewer"), wrap(() =>
  all("SELECT s.*, a.handle, p.title FROM submissions s JOIN agents a ON a.id=s.agent_id JOIN problems p ON p.id=s.problem_id ORDER BY s.id DESC LIMIT 300")
    .map((s) => ({ ...s, reviews: all("SELECT r.*, a.handle FROM reviews r JOIN agents a ON a.id=r.agent_id WHERE submission_id=?", s.id) }))));

// ---------- subscriptions ----------

api.get("/subs", need("viewer"), wrap((req) => all("SELECT * FROM subscriptions WHERE status!='detached' ORDER BY created_at").map((s) => subView(s, roleOf(req) === "admin"))));
api.get("/subs/local", need("admin"), wrap(() => scanLocalLogins()));
api.post("/subs/import", need("admin"), wrap((req) => {
  const b = req.body ?? {};
  const cands = scanLocalLogins();
  const c = cands.find((x) => x.abs === b.path);
  if (!c) throw new Error("that login was not found on this machine");
  if (c.attached_sub) throw new Error("that login is already attached");
  return importLocalLogin(c.abs, String(b.label || c.email || "local login").slice(0, 60), b.owner ? String(b.owner).slice(0, 60) : null, {
    agents_target: b.agents_target !== undefined ? clampInt(b.agents_target, 0, 8, DEFAULTS.agentsPerSub) : undefined,
    reserve_pct: b.reserve_pct !== undefined ? clampInt(b.reserve_pct, 5, 100, DEFAULTS.reservePct) : undefined,
  });
}));
api.post("/subs/device", need("viewer"), wrap(async (req, res) => {
  const rl = deviceLoginLimiter.consume(clientIp(req));
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(rl.retryAfterSec));
    res.status(429).json({ error: "too many device sign-ins started; please wait a few minutes" });
    return;
  }
  const b = req.body ?? {};
  const pending = (one("SELECT count(*) n FROM subscriptions WHERE status='pending_auth'") as Row).n;
  if (pending >= 5) throw new Error("too many sign-ins in progress; try again in a few minutes");
  return startDeviceLogin(String(b.label || "Codex subscription").trim().slice(0, 60) || "Codex subscription", b.owner ? String(b.owner).trim().slice(0, 60) : null);
}));
api.post("/subs/:id/verify", wrap(async (req, res) => {
  const auth = canManage(req, String(req.params.id));
  if (auth.rateLimited) { res.setHeader("Retry-After", String(auth.rateLimited)); return res.status(429).json({ error: "too many attempts" }); }
  if (!auth.ok) return res.status(403).json({ error: "not allowed" });
  return { ok: await verifySub(String(req.params.id)) };
}));
api.patch("/subs/:id", wrap((req, res) => {
  const auth = canManage(req, String(req.params.id));
  if (auth.rateLimited) { res.setHeader("Retry-After", String(auth.rateLimited)); return res.status(429).json({ error: "too many attempts" }); }
  if (!auth.ok) return res.status(403).json({ error: "not allowed" });
  const b = req.body ?? {};
  const s = one("SELECT * FROM subscriptions WHERE id=?", req.params.id);
  if (!s) throw new Error("not found");
  const changes: Record<string, unknown> = {};
  if (b.agents_target !== undefined) {
    const val = clampInt(b.agents_target, 0, 8, -1);
    if (val < 0) throw new Error("agents_target must be between 0 and 8");
    run("UPDATE subscriptions SET agents_target=? WHERE id=?", val, s.id);
    changes.agents_target = val;
  }
  if (b.reserve_pct !== undefined) {
    const val = clampInt(b.reserve_pct, 5, 100, -1);
    if (val < 0) throw new Error("reserve_pct must be between 5 and 100");
    run("UPDATE subscriptions SET reserve_pct=? WHERE id=?", val, s.id);
    changes.reserve_pct = val;
  }
  if (b.model !== undefined) {
    const model = String(b.model).trim();
    if (!MODEL_RE.test(model)) throw new Error("invalid model name");
    run("UPDATE subscriptions SET model=? WHERE id=?", model, s.id);
    changes.model = model;
  }
  if (b.effort !== undefined) {
    const effort = String(b.effort).trim();
    if (!(ALLOWED_EFFORTS as readonly string[]).includes(effort)) throw new Error("invalid effort value");
    run("UPDATE subscriptions SET effort=? WHERE id=?", effort, s.id);
    changes.effort = effort;
  }
  if (b.label !== undefined) {
    const label = String(b.label).trim().slice(0, 60);
    if (!label) throw new Error("label cannot be empty");
    run("UPDATE subscriptions SET label=? WHERE id=?", label, s.id);
    changes.label = label;
  }
  if (Object.keys(changes).length) {
    sysEvent("info", "sub.updated", `"${s.label}" settings changed: ${Object.keys(changes).join(", ")}`, { sub_id: s.id }, changes);
  }
  supervisor.ensureAll();
  emitSub(s.id);
  return { ok: true };
}));
api.post("/subs/:id/:action(pause|resume)", wrap((req, res) => {
  const auth = canManage(req, String(req.params.id));
  if (auth.rateLimited) { res.setHeader("Retry-After", String(auth.rateLimited)); return res.status(429).json({ error: "too many attempts" }); }
  if (!auth.ok) return res.status(403).json({ error: "not allowed" });
  const s = one("SELECT * FROM subscriptions WHERE id=?", req.params.id);
  if (!s) throw new Error("not found");
  if (req.params.action === "pause" && s.status === "active") run("UPDATE subscriptions SET status='paused' WHERE id=?", s.id);
  if (req.params.action === "resume" && s.status === "paused") run("UPDATE subscriptions SET status='active' WHERE id=?", s.id);
  sysEvent("info", `sub.${req.params.action}d`, `"${s.label}" ${req.params.action}d by its owner`, { sub_id: s.id });
  emitSub(s.id);
  return { ok: true };
}));
api.delete("/subs/:id", wrap((req, res) => {
  const auth = canManage(req, String(req.params.id));
  if (auth.rateLimited) { res.setHeader("Retry-After", String(auth.rateLimited)); return res.status(429).json({ error: "too many attempts" }); }
  if (!auth.ok) return res.status(403).json({ error: "not allowed" });
  const s = one("SELECT * FROM subscriptions WHERE id=?", req.params.id);
  if (!s) throw new Error("not found");
  run("UPDATE subscriptions SET status='detached', agents_target=0 WHERE id=?", s.id);
  for (const a of all("SELECT * FROM agents WHERE sub_id=? AND status!='retired'", s.id)) {
    run("UPDATE agents SET enabled=0 WHERE id=?", a.id);
    if (a.current_run_id) supervisor.stopRun(a.current_run_id, "operator: subscription detached");
  }
  // Stop a sign-in that is still waiting (verified against PID reuse), then remove our handle on credentials.
  // For an imported login this only removes the symlink; the original login is untouched.
  const device = parse<Row>(s.device, {});
  if (device.pid && isRunAlive(device.pid, "login")) {
    killGroup(device.pid, "SIGTERM");
  }
  try { fs.unlinkSync(path.join(s.home, "auth.json")); } catch { /* already gone */ }
  sysEvent("warn", "sub.detached", `"${s.label}" detached; its agents are stopping and its credentials were removed from Agora`, { sub_id: s.id });
  emitSub(s.id);
  return { ok: true };
}));

// ---------- analytics ----------

function interactionsFor(agentId: string) {
  const g = graph();
  return {
    edges: g.edges.filter((e) => e.source === agentId || e.target === agentId),
  };
}

/** Who talks to whom. Edges are typed so the UI can toggle reply / mention / review / read / co-thread. */
function graph() {
  const agents = all("SELECT id, handle, sub_id FROM agents");
  const edges = new Map<string, { source: string; target: string; type: string; weight: number; first: number; last: number }>();
  const add = (s: string | null, t: string | null, type: string, ts: number) => {
    if (!s || !t || s === t) return;
    const k = `${type}|${s}|${t}`;
    const e = edges.get(k);
    if (e) { e.weight++; e.last = Math.max(e.last, ts); e.first = Math.min(e.first, ts); }
    else edges.set(k, { source: s, target: t, type, weight: 1, first: ts, last: ts });
  };
  for (const r of all("SELECT c.agent_id s, p.agent_id t, c.ts FROM posts c JOIN posts p ON p.id=c.parent_id WHERE c.agent_id IS NOT NULL AND p.agent_id IS NOT NULL")) add(r.s, r.t, "reply", r.ts);
  for (const p of all("SELECT agent_id, mentions, to_agent_id, ts FROM posts WHERE agent_id IS NOT NULL")) {
    for (const m of parse<string[]>(p.mentions, [])) add(p.agent_id, m, "mention", p.ts);
    if (p.to_agent_id) add(p.agent_id, p.to_agent_id, "message", p.ts);
  }
  for (const r of all("SELECT r.agent_id s, s.agent_id t, r.ts FROM reviews r JOIN submissions s ON s.id=r.submission_id")) add(r.s, r.t, "review", r.ts);
  // Reads: B read a post written by A means information flowed A -> B.
  const author = new Map(all("SELECT id, agent_id FROM posts WHERE agent_id IS NOT NULL").map((p) => [p.id as number, p.agent_id as string]));
  for (const r of all("SELECT agent_id, post_ids, ts FROM reads")) {
    const seen = new Set<string>();
    for (const pid of parse<number[]>(r.post_ids, [])) {
      const a = author.get(pid);
      if (a && a !== r.agent_id && !seen.has(a)) { seen.add(a); add(a, r.agent_id, "read", r.ts); }
    }
  }
  // Shared threads.
  const byThread = all("SELECT problem_id, agent_id, min(ts) ts FROM posts WHERE channel='problem' AND agent_id IS NOT NULL GROUP BY problem_id, agent_id");
  const groups = new Map<number, { a: string; ts: number }[]>();
  for (const r of byThread) { const g = groups.get(r.problem_id) ?? []; g.push({ a: r.agent_id, ts: r.ts }); groups.set(r.problem_id, g); }
  for (const g of groups.values()) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) add(g[i].a, g[j].a, "cothread", Math.max(g[i].ts, g[j].ts));
  const postsBy = all("SELECT agent_id, count(*) n FROM posts WHERE agent_id IS NOT NULL GROUP BY agent_id").reduce<Record<string, number>>((m, r) => ((m[r.agent_id] = r.n), m), {});
  const work = all(`SELECT p.agent_id, p.problem_id, pr.title, pr.domain, count(*) n, max(p.ts) last FROM posts p JOIN problems pr ON pr.id=p.problem_id
                    WHERE p.channel='problem' AND p.agent_id IS NOT NULL GROUP BY p.agent_id, p.problem_id`);
  return { nodes: agents.map((a) => ({ id: a.id, handle: a.handle, sub_id: a.sub_id, posts: postsBy[a.id] ?? 0 })), edges: [...edges.values()], work };
}
api.get("/analytics/graph", need("viewer"), wrap(() => graph()));

api.get("/analytics/volume", need("viewer"), wrap((req) => {
  const bucket = clampInt(req.query.bucket, 60_000, 86_400_000, 600_000);
  const since = clampInt(req.query.since, 0, Number.MAX_SAFE_INTEGER, 0);
  const rows = all(
    `SELECT CAST(ts/? AS INTEGER)*? b, kind, author_type, count(*) n FROM posts WHERE ts>=? GROUP BY b, kind, author_type ORDER BY b`, bucket, bucket, since,
  );
  const tools = all(
    `SELECT CAST(ts/? AS INTEGER)*? b, json_extract(data,'$.tool') tool, count(*) n FROM run_events WHERE kind='tool' AND ts>=? GROUP BY b, tool ORDER BY b`, bucket, bucket, since,
  );
  const domains = all(
    `SELECT CAST(p.ts/? AS INTEGER)*? b, pr.domain, count(*) n FROM posts p JOIN problems pr ON pr.id=p.problem_id WHERE p.ts>=? GROUP BY b, pr.domain ORDER BY b`, bucket, bucket, since,
  );
  return { bucket, posts: rows, tools, domains };
}));

api.get("/analytics/timeline", need("viewer"), wrap(() => {
  const agents = all("SELECT * FROM agents ORDER BY created_at").map(agentView);
  const runs = all("SELECT r.id, r.agent_id, r.kind, r.role, r.problem_id, r.submission_id, r.state, r.outcome, r.started_at, r.ended_at, r.resumes, p.domain, p.title FROM runs r LEFT JOIN problems p ON p.id=r.problem_id ORDER BY r.started_at");
  const posts = all("SELECT id, ts, agent_id, kind, problem_id, channel, parent_id, to_agent_id, mentions FROM posts WHERE agent_id IS NOT NULL ORDER BY id").map((p) => ({ ...p, mentions: parse(p.mentions, []) }));
  const reads = all("SELECT ts, agent_id, target FROM reads ORDER BY id");
  const incidents = all("SELECT id, ts, level, kind, agent_id, run_id, message FROM sys_events WHERE agent_id IS NOT NULL AND kind IN ('run.crashed','run.resumed','run.reattached','run.stalled','run.timeout','chaos.kill','lease.expired','run.failed','run.ended_unwatched') ORDER BY id");
  const statuses = all("SELECT ts, agent_id, message FROM sys_events WHERE 0");
  return { agents, runs, posts, reads, incidents, statuses, now: now() };
}));

// ---------- system / reliability ----------

api.get("/system/events", need("viewer"), wrap((req) => {
  const before = clampInt(req.query.before, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const rawLevel = typeof req.query.level === "string" ? req.query.level : undefined;
  const level = rawLevel && SYS_LEVELS.has(rawLevel) ? rawLevel : undefined;
  const limit = clampInt(req.query.limit, 1, 500, 200);
  return all(`SELECT * FROM sys_events WHERE id<? ${level ? "AND level=?" : ""} ORDER BY id DESC LIMIT ?`, before, ...(level ? [level] : []), limit)
    .map((e) => ({ ...e, data: parse(e.data, {}) }));
}));
api.get("/system/health", need("viewer"), wrap(() => {
  const count = (k: string) => (one("SELECT count(*) n FROM sys_events WHERE kind=?", k) as Row).n as number;
  const live = all("SELECT id, agent_id, pid, last_event_at FROM runs WHERE proc='live'");
  return {
    hub: { pid: process.pid, started_at: HUB_STARTED, uptime_s: Math.round((now() - HUB_STARTED) / 1000), restarts: count("hub.started") - 1, streams: streamCount(), loops: supervisor.loops.size },
    recoveries: {
      crashes: count("run.crashed"), resumed: count("run.resumed"), reattached: count("run.reattached"), stalls: count("run.stalled"),
      lease_expired: count("lease.expired"), chaos_kills: count("chaos.kill"), rate_limited: count("sub.rate_limited"), nudges: count("run.nudged"),
      completed: count("run.completed"), failed: count("run.failed"),
    },
    live_processes: live.length,
    live,
    outage_until: outageUntil > now() ? outageUntil : null,
  };
}));

api.post("/chaos/:action", need("admin"), wrap((req) => {
  switch (req.params.action) {
    case "kill": return supervisor.chaosKill(typeof req.body?.agent_id === "string" ? req.body.agent_id : undefined) ?? { error: "no live agent process to kill" };
    case "restart-hub":
      sysEvent("warn", "chaos.restart_hub", "Chaos: restarting the hub process. Agents keep running; the new hub re-attaches to them.");
      setTimeout(() => process.exit(75), 400);
      return { ok: true };
    case "quota": {
      const subId = String(req.body?.sub_id ?? (one("SELECT id FROM subscriptions WHERE status='active' ORDER BY created_at LIMIT 1")?.id ?? ""));
      const secs = clampInt(req.body?.seconds, 30, 1800, 120);
      return supervisor.chaosQuota(subId, secs) ?? { error: "no active subscription" };
    }
    case "outage": {
      const secs = clampInt(req.body?.seconds, 5, 300, 45);
      outageUntil = now() + secs * 1000;
      sysEvent("warn", "chaos.outage", `Chaos: the agent API returns 503 for ${secs}s. Board tools retry; agents should ride it out.`, {}, { seconds: secs });
      setTimeout(() => sysEvent("ok", "chaos.outage_over", "Agent API is back"), secs * 1000).unref();
      return { ok: true, until: outageUntil };
    }
    default: throw new Error("unknown chaos action");
  }
}));

api.get("/poll", need("viewer"), wrap(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const after = clampInt(req.query.after, -1, Number.MAX_SAFE_INTEGER, 0);
  const waitMs = clampInt(req.query.wait, 0, 25_000, 20_000);
  return poll(after, (req.query.boot as string) || undefined, (req.query.run as string) || undefined, waitMs, ac.signal);
}));

api.get("/stream", need("viewer"), (req, res) => {
  const last = clampInt(req.headers["last-event-id"] ?? req.query.last, 0, Number.MAX_SAFE_INTEGER, 0) || undefined;
  if (!attachStream(res, last, (req.query.run as string) || undefined)) {
    res.status(503).json({ error: "too many active streams" });
  }
});
