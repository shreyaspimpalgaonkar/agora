import { db, one, all, run, parse, kvGet, kvSet, type Row } from "./db.js";
import { emit, sysEvent } from "./bus.js";
import { DEFAULTS, now } from "./config.js";
import { redact, clampInt } from "./security.js";

export { redact };
export const CHANNELS = ["general", "coordination", "results", "reviews"] as const;
export const ALL_CHANNELS = ["general", "coordination", "results", "reviews", "problem", "dm"] as const;
export const POST_KINDS = [
  "plan", "idea", "lemma", "computation", "literature", "dead_end", "question", "answer",
  "note", "handoff", "result", "review", "claim", "alert", "announcement", "message",
] as const;
export const OUTCOMES = ["solved", "disproved", "partial", "no_progress"] as const;
export const VERDICTS = ["accept", "needs_work", "reject"] as const;

const REVIEWS_NEEDED: Record<string, number> = { solved: 2, disproved: 2, partial: 1 };

// ---------- helpers ----------

export function agentByHandle(handle: string) {
  return one("SELECT * FROM agents WHERE upper(handle)=upper(?)", handle.replace(/^@/, ""));
}

function extractMentions(body: string): string[] {
  const handles = new Set<string>();
  for (const m of body.matchAll(/@([A-Za-z]+-\d+)/g)) {
    const a = agentByHandle(m[1]);
    if (a) handles.add(a.id);
  }
  return [...handles];
}

export function postView(p: Row) {
  const agent = p.agent_id ? one("SELECT handle, sub_id FROM agents WHERE id=?", p.agent_id) : undefined;
  return {
    id: p.id, ts: p.ts, channel: p.channel, problem_id: p.problem_id, parent_id: p.parent_id,
    author_type: p.author_type, agent_id: p.agent_id, run_id: p.run_id,
    author: agent?.handle ?? p.author_name ?? "system",
    kind: p.kind, title: p.title, body: p.body,
    mentions: parse<string[]>(p.mentions, []).map((id) => one("SELECT handle FROM agents WHERE id=?", id)?.handle).filter(Boolean),
    to: p.to_agent_id ? one("SELECT handle FROM agents WHERE id=?", p.to_agent_id)?.handle : null,
    meta: parse(p.meta, {}),
  };
}

export function touchProblem(problemId: number) {
  run("UPDATE problems SET last_activity_at=? WHERE id=?", now(), problemId);
}

// ---------- posts ----------

export function createPost(input: {
  channel: string; problem_id?: number | null; parent_id?: number | null;
  author_type: "agent" | "human" | "system"; agent_id?: string | null; run_id?: string | null; author_name?: string | null;
  kind: string; title?: string | null; body: string; to_agent_id?: string | null; meta?: unknown;
}) {
  const body = redact(input.body).slice(0, 60000);
  if (!body.trim()) throw new Error("post body cannot be empty");
  const title = input.title ? redact(input.title).slice(0, 200) : null;
  let channel = input.channel;
  let problemId = input.problem_id ?? null;
  if (input.parent_id) {
    const parent = one("SELECT channel, problem_id FROM posts WHERE id=?", input.parent_id);
    if (!parent) throw new Error(`reply_to post ${input.parent_id} does not exist`);
    channel = parent.channel;
    problemId = parent.problem_id;
  }
  if (!(ALL_CHANNELS as readonly string[]).includes(channel)) throw new Error(`invalid channel: ${channel}`);
  if (!(POST_KINDS as readonly string[]).includes(input.kind)) throw new Error(`invalid post kind: ${input.kind}`);
  if (channel === "problem" && !problemId) throw new Error("problem posts need a problem_id");
  if (problemId && !one("SELECT id FROM problems WHERE id=?", problemId)) throw new Error(`problem ${problemId} does not exist`);
  const mentions = extractMentions(body);
  const ts = now();
  const r = run(
    `INSERT INTO posts(ts,channel,problem_id,parent_id,author_type,agent_id,run_id,author_name,kind,title,body,mentions,to_agent_id,meta)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ts, channel, problemId, input.parent_id ?? null, input.author_type, input.agent_id ?? null, input.run_id ?? null,
    input.author_name ?? null, input.kind, title, body, JSON.stringify(mentions), input.to_agent_id ?? null, JSON.stringify(input.meta ?? {}),
  );
  const id = Number(r.lastInsertRowid);
  if (problemId) {
    run("UPDATE problems SET posts=posts+1, last_activity_at=? WHERE id=?", ts, problemId);
  }
  if (input.agent_id) {
    run("UPDATE agents SET first_post_at=coalesce(first_post_at, ?), last_active_at=? WHERE id=?", ts, ts, input.agent_id);
  }
  const view = postView(one("SELECT * FROM posts WHERE id=?", id)!);
  emit("post", view);
  return view;
}

export function systemPost(channel: string, kind: string, body: string, problemId?: number | null, meta?: unknown) {
  return createPost({ channel, problem_id: problemId ?? null, author_type: "system", author_name: "agora", kind, body, meta });
}

// ---------- reads (who saw what: the raw material for the information-flow graph) ----------

export function recordRead(agentId: string, runId: string | null, target: string, postIds: number[]) {
  const ts = now();
  run("INSERT INTO reads(ts,agent_id,run_id,target,post_ids) VALUES(?,?,?,?,?)", ts, agentId, runId, target, JSON.stringify(postIds.slice(-300)));
  run("UPDATE agents SET first_seen_board_at=coalesce(first_seen_board_at, ?) WHERE id=?", ts, agentId);
  emit("read", { ts, agent_id: agentId, run_id: runId, target, count: postIds.length });
}

export function readThread(problemId: number, sinceId = 0, limit = 120) {
  const safeSince = clampInt(sinceId, 0, Number.MAX_SAFE_INTEGER, 0);
  const safeLimit = clampInt(limit, 1, 500, 120);
  const rows = all("SELECT * FROM posts WHERE problem_id=? AND channel='problem' AND id>? ORDER BY id DESC LIMIT ?", problemId, safeSince, safeLimit).reverse();
  return rows.map(postView);
}

export function readFeed(channel: string | null, limit = 40, sinceId = 0) {
  const safeSince = clampInt(sinceId, 0, Number.MAX_SAFE_INTEGER, 0);
  const safeLimit = clampInt(limit, 1, 200, 40);
  const rows = channel && channel !== "all"
    ? all("SELECT * FROM posts WHERE channel=? AND id>? ORDER BY id DESC LIMIT ?", channel, safeSince, safeLimit)
    : all("SELECT * FROM posts WHERE channel!='dm' AND id>? ORDER BY id DESC LIMIT ?", safeSince, safeLimit);
  return rows.reverse().map(postView);
}

export function searchPosts(query: string, limit = 20) {
  const safeLimit = clampInt(limit, 1, 200, 20);
  const terms = query
    .slice(0, 200)
    .replace(/["*^:(){}[\]+-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 20);
  if (!terms.length) return [];
  const q = terms.map((w) => `"${w}"`).join(" OR ");
  try {
    return all(
      `SELECT p.* FROM posts_fts f JOIN posts p ON p.id=f.rowid WHERE posts_fts MATCH ? ORDER BY rank LIMIT ?`, q, safeLimit,
    ).map(postView);
  } catch {
    return [];
  }
}

export function inbox(agentId: string) {
  const key = `inbox:${agentId}`;
  const cursor = kvGet<number>(key, 0);
  const current = one("SELECT problem_id FROM leases WHERE agent_id=? AND released_at IS NULL ORDER BY id DESC LIMIT 1", agentId);
  const args: unknown[] = [cursor, agentId, `%"${agentId}"%`, agentId, agentId];
  let threadClause = "";
  if (current) {
    threadClause = "OR (problem_id=? AND channel='problem')";
    args.push(Number(current.problem_id));
  }
  const rows = all(
    `SELECT * FROM posts WHERE id>? AND (agent_id IS NULL OR agent_id!=?) AND (
        mentions LIKE ? OR to_agent_id=? OR parent_id IN (SELECT id FROM posts WHERE agent_id=?)
        ${threadClause}
     ) ORDER BY id ASC LIMIT 60`,
    ...args,
  );
  const maxId = (one("SELECT max(id) m FROM posts") as Row).m ?? 0;
  kvSet(key, maxId);
  const me = one("SELECT handle FROM agents WHERE id=?", agentId)?.handle;
  // System notices about this agent's own actions are not news to it.
  return rows.filter((p) => !(p.author_type === "system" && parse<Row>(p.meta, {}).agent === me)).map(postView);
}

// ---------- problems ----------

export function problemView(p: Row, detail = false) {
  const leases = all(
    `SELECT l.*, a.handle FROM leases l JOIN agents a ON a.id=l.agent_id WHERE l.problem_id=? AND l.released_at IS NULL`, p.id,
  );
  const base = {
    id: p.id, slug: p.slug, title: p.title, domain: p.domain, domain_label: p.domain_label,
    atlas_status: p.atlas_status, openai_partial: !!p.openai_partial, state: p.state,
    attempts: p.attempts, posts: p.posts, last_activity_at: p.last_activity_at,
    active: leases.map((l) => ({ agent_id: l.agent_id, handle: l.handle, kind: l.kind, role: l.role, since: l.acquired_at })),
  };
  if (!detail) return base;
  const meta = parse<Row>(p.meta, {});
  return {
    ...base, statement: p.statement, question: p.question, why: p.why, family: p.family, atlas_note: p.atlas_note, ...meta,
    submissions: all("SELECT s.*, a.handle FROM submissions s JOIN agents a ON a.id=s.agent_id WHERE problem_id=? ORDER BY id DESC", p.id)
      .map((s) => ({ ...s, reviews: all("SELECT r.*, a.handle FROM reviews r JOIN agents a ON a.id=r.agent_id WHERE submission_id=? ORDER BY id", s.id) })),
    runs: all(`SELECT r.id, r.kind, r.state, r.outcome, r.started_at, r.ended_at, r.agent_id, a.handle FROM runs r JOIN agents a ON a.id=r.agent_id
               WHERE r.problem_id=? ORDER BY r.started_at DESC LIMIT 50`, p.id),
  };
}

export function recomputeProblemState(problemId: number) {
  const subs = all("SELECT outcome, review_state FROM submissions WHERE problem_id=?", problemId);
  const p = one("SELECT attempts FROM problems WHERE id=?", problemId);
  let state = (p?.attempts ?? 0) > 0 ? "explored" : "open";
  const decisive = subs.filter((s) => s.outcome === "solved" || s.outcome === "disproved");
  if (subs.some((s) => s.outcome === "partial" && s.review_state !== "rejected")) state = "partial";
  if (decisive.some((s) => s.review_state === "pending")) state = "claimed";
  if (decisive.some((s) => s.review_state === "contested")) state = "contested";
  if (decisive.some((s) => s.review_state === "accepted")) state = "verified";
  run("UPDATE problems SET state=? WHERE id=?", state, problemId);
  emit("problem", problemView(one("SELECT * FROM problems WHERE id=?", problemId)!));
  return state;
}

// ---------- leases ----------

export function openLeases(problemId?: number) {
  return problemId
    ? all("SELECT * FROM leases WHERE released_at IS NULL AND problem_id=?", problemId)
    : all("SELECT * FROM leases WHERE released_at IS NULL");
}

export function acquireLease(agentId: string, runId: string, problemId: number, kind: "attempt" | "review", role: string) {
  const ts = now();
  run(
    "INSERT INTO leases(problem_id,agent_id,run_id,kind,role,acquired_at,expires_at) VALUES(?,?,?,?,?,?,?)",
    problemId, agentId, runId, kind, role, ts, ts + DEFAULTS.leaseMin * 60_000,
  );
  if (kind === "attempt") run("UPDATE problems SET attempts=attempts+1, last_activity_at=? WHERE id=?", ts, problemId);
  recomputeProblemState(problemId);
}

export function renewLease(runId: string) {
  run("UPDATE leases SET expires_at=? WHERE run_id=? AND released_at IS NULL", now() + DEFAULTS.leaseMin * 60_000, runId);
}

export function releaseLeases(runId: string, reason: string) {
  const open = all("SELECT * FROM leases WHERE run_id=? AND released_at IS NULL", runId);
  run("UPDATE leases SET released_at=?, reason=? WHERE run_id=? AND released_at IS NULL", now(), reason, runId);
  for (const l of open) recomputeProblemState(l.problem_id);
  return open;
}

/** Leases whose agent went silent: free the problem so another agent can pick it up. */
export function expireLeases() {
  const stale = all("SELECT l.*, a.handle FROM leases l JOIN agents a ON a.id=l.agent_id WHERE l.released_at IS NULL AND l.expires_at < ?", now());
  for (const l of stale) {
    run("UPDATE leases SET released_at=?, reason='expired' WHERE id=?", now(), l.id);
    recomputeProblemState(l.problem_id);
    sysEvent("warn", "lease.expired", `${l.handle} went quiet on #${l.problem_id}; lease released`, { agent_id: l.agent_id, run_id: l.run_id, problem_id: l.problem_id });
    systemPost("coordination", "alert", `Lease on #${l.problem_id} expired: @${l.handle} was silent for ${DEFAULTS.leaseMin} min. The problem is open for pickup again.`, null, { problem_id: l.problem_id });
  }
}

// ---------- submissions and reviews ----------

export function submit(agentId: string, runId: string, problemId: number, outcome: string, summary: string, writeup: string, handoff?: string | null) {
  if (!(OUTCOMES as readonly string[]).includes(outcome)) throw new Error(`invalid outcome: ${outcome}`);
  const cleanSummary = redact(summary).trim().slice(0, 4000);
  const cleanWriteup = redact(writeup).trim().slice(0, 120000);
  const cleanHandoff = handoff ? redact(handoff).trim().slice(0, 8000) : null;
  if (!cleanSummary) throw new Error("summary cannot be empty");
  if (!cleanWriteup) throw new Error("writeup cannot be empty");
  const needed = REVIEWS_NEEDED[outcome] ?? 0;
  const already = one("SELECT id FROM submissions WHERE run_id=? AND problem_id=?", runId, problemId);
  if (already) throw new Error(`this run already submitted (submission S${already.id}); post follow-ups to the thread instead`);
  const ts = now();
  const r = run(
    `INSERT INTO submissions(ts,problem_id,agent_id,run_id,outcome,summary,writeup,handoff,review_state) VALUES(?,?,?,?,?,?,?,?,?)`,
    ts, problemId, agentId, runId, outcome, cleanSummary, cleanWriteup, cleanHandoff,
    needed ? "pending" : "none",
  );
  const sid = Number(r.lastInsertRowid);
  const agent = one("SELECT handle FROM agents WHERE id=?", agentId)!;
  const label = { solved: "claims a SOLUTION", disproved: "claims a DISPROOF", partial: "reports a partial result", no_progress: "reports no progress" }[outcome] ?? outcome;
  const post = createPost({
    channel: "problem", problem_id: problemId, author_type: "agent", agent_id: agentId, run_id: runId, kind: "result",
    title: `S${sid} · ${outcome.replace("_", " ")}`, body: `${cleanSummary}\n\n${cleanHandoff ? `**Handoff for the next agent:** ${cleanHandoff}` : ""}`.trim(),
    meta: { submission_id: sid, outcome },
  });
  run("UPDATE submissions SET post_id=? WHERE id=?", post.id, sid);
  if (outcome !== "no_progress") {
    systemPost("results", "result", `@${agent.handle} ${label} on #${problemId} (S${sid}). ${needed ? `Needs ${needed} independent review${needed > 1 ? "s" : ""}.` : ""}\n\n> ${cleanSummary.slice(0, 400)}`, null, { submission_id: sid, problem_id: problemId, outcome });
  }
  recomputeProblemState(problemId);
  emit("submission", { id: sid, problem_id: problemId, agent_id: agentId, outcome });
  return { submission_id: sid, review_state: needed ? "pending" : "none", reviews_needed: needed };
}

export function review(agentId: string, runId: string, submissionId: number, verdict: string, body: string) {
  if (!(VERDICTS as readonly string[]).includes(verdict)) throw new Error(`invalid verdict: ${verdict}`);
  const cleanBody = redact(body).trim().slice(0, 40000);
  if (!cleanBody) throw new Error("review body cannot be empty");
  const s = one("SELECT * FROM submissions WHERE id=?", submissionId);
  if (!s) throw new Error(`submission S${submissionId} does not exist`);
  if (s.agent_id === agentId) throw new Error("you cannot review your own submission");
  if (one("SELECT id FROM reviews WHERE submission_id=? AND agent_id=?", submissionId, agentId)) throw new Error("you already reviewed this submission");
  const agent = one("SELECT handle FROM agents WHERE id=?", agentId)!;
  const author = one("SELECT handle FROM agents WHERE id=?", s.agent_id)!;
  const post = createPost({
    channel: "problem", problem_id: s.problem_id, parent_id: s.post_id ?? null, author_type: "agent", agent_id: agentId, run_id: runId,
    kind: "review", title: `Review of S${submissionId}: ${verdict.replace("_", " ")}`, body: `@${author.handle} ${cleanBody}`,
    meta: { submission_id: submissionId, verdict },
  });
  run("INSERT INTO reviews(ts,submission_id,agent_id,run_id,verdict,body,post_id) VALUES(?,?,?,?,?,?,?)", now(), submissionId, agentId, runId, verdict, cleanBody, post.id);
  const accepts = (one("SELECT count(*) n FROM reviews WHERE submission_id=? AND verdict='accept'", submissionId) as Row).n;
  const rejects = (one("SELECT count(*) n FROM reviews WHERE submission_id=? AND verdict!='accept'", submissionId) as Row).n;
  const needed = REVIEWS_NEEDED[s.outcome] ?? 1;
  let state = "pending";
  if (accepts + rejects >= needed) state = rejects === 0 ? "accepted" : accepts === 0 ? "rejected" : "contested";
  run("UPDATE submissions SET accepts=?, rejects=?, review_state=? WHERE id=?", accepts, rejects, state, submissionId);
  systemPost("reviews", "review", `@${agent.handle} reviewed S${submissionId} by @${author.handle} on #${s.problem_id}: **${verdict.replace("_", " ")}**. Status: ${state}.`, null, { submission_id: submissionId, problem_id: s.problem_id, verdict });
  recomputeProblemState(s.problem_id);
  emit("submission", { id: submissionId, problem_id: s.problem_id, review_state: state });
  return { review_state: state, accepts, rejects };
}

// ---------- scheduling ----------

export type Task =
  | { kind: "attempt"; problem_id: number; role: "lead" | "partner"; partner_handles: string[]; reason: string }
  | { kind: "review"; problem_id: number; submission_id: number; reason: string };

/**
 * Decide what an idle agent should do next. Reviews of pending claims come first, then
 * joining a problem that one other agent is working on right now (so pairs can talk in the
 * thread), then follow-ups on problems that have handoff notes, then fresh problems.
 */
export function pickTask(agentId: string): Task | null {
  const settings = kvGet("settings", { collabRate: 0.45, followupRate: 0.35, maxPerProblem: 2 });
  const busy = new Set(openLeases().map((l) => l.problem_id as number));

  const pending = all(
    `SELECT s.* FROM submissions s WHERE s.review_state='pending' AND s.agent_id!=?
       AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.submission_id=s.id AND r.agent_id=?)
       AND (SELECT count(*) FROM reviews r WHERE r.submission_id=s.id)
         + (SELECT count(*) FROM leases l JOIN runs ru ON ru.id=l.run_id WHERE l.released_at IS NULL AND l.kind='review' AND ru.submission_id=s.id)
         < CASE s.outcome WHEN 'partial' THEN 1 ELSE 2 END
     ORDER BY s.id ASC LIMIT 1`, agentId, agentId,
  );
  if (pending.length) {
    const s = pending[0];
    return { kind: "review", problem_id: s.problem_id, submission_id: s.id, reason: `S${s.id} needs an independent review` };
  }

  const lastOwn = one("SELECT problem_id FROM runs WHERE agent_id=? ORDER BY started_at DESC LIMIT 1", agentId)?.problem_id;
  if (Math.random() < settings.collabRate) {
    const solo = all(
      `SELECT l.problem_id, group_concat(a.handle) handles, count(*) n, min(l.acquired_at) since FROM leases l JOIN agents a ON a.id=l.agent_id
       WHERE l.released_at IS NULL AND l.kind='attempt' AND l.agent_id!=? GROUP BY l.problem_id HAVING n < ? ORDER BY since ASC`,
      agentId, settings.maxPerProblem,
    ).filter((r) => r.problem_id !== lastOwn && !all("SELECT 1 FROM leases WHERE released_at IS NULL AND problem_id=? AND agent_id=?", r.problem_id, agentId).length);
    if (solo.length) {
      const r = solo[Math.floor(Math.random() * Math.min(3, solo.length))];
      return { kind: "attempt", problem_id: r.problem_id, role: "partner", partner_handles: String(r.handles).split(","), reason: `join ${r.handles} on #${r.problem_id}` };
    }
  }

  const recent = new Set(all("SELECT problem_id FROM runs WHERE agent_id=? AND problem_id IS NOT NULL ORDER BY started_at DESC LIMIT 6", agentId).map((r) => r.problem_id));
  const activeDomains = all(
    "SELECT p.domain, count(*) n FROM leases l JOIN problems p ON p.id=l.problem_id WHERE l.released_at IS NULL GROUP BY p.domain",
  ).reduce<Record<string, number>>((m, r) => ((m[r.domain] = r.n), m), {});

  if (Math.random() < settings.followupRate) {
    const follow = all(
      `SELECT p.id FROM problems p WHERE p.attempts>0 AND p.state IN ('explored','partial','contested')
         AND EXISTS (SELECT 1 FROM submissions s WHERE s.problem_id=p.id AND (s.handoff IS NOT NULL OR s.outcome='partial'))
       ORDER BY p.last_activity_at DESC LIMIT 25`,
    ).filter((r) => !busy.has(r.id) && !recent.has(r.id));
    if (follow.length) {
      const pid = follow[Math.floor(Math.random() * Math.min(5, follow.length))].id;
      return { kind: "attempt", problem_id: pid, role: "lead", partner_handles: [], reason: `follow up on handoff notes for #${pid}` };
    }
  }

  // Fresh problem: weigh importance (low rank number) against how often it has been tried,
  // and spread agents across domains.
  const cands = all("SELECT id, domain, attempts FROM problems WHERE state IN ('open','explored','partial')");
  let best: { id: number; score: number } | null = null;
  for (const c of cands) {
    if (busy.has(c.id) || recent.has(c.id)) continue;
    const importance = 1 - c.id / 520;
    const novelty = 1 / (1 + c.attempts);
    const crowd = activeDomains[c.domain] ?? 0;
    const score = 0.9 * importance + 1.2 * novelty - 0.5 * crowd + Math.random() * 0.9;
    if (!best || score > best.score) best = { id: c.id, score };
  }
  if (!best) return null;
  return { kind: "attempt", problem_id: best.id, role: "lead", partner_handles: [], reason: `fresh problem #${best.id}` };
}

export function boardStats() {
  const c = (sql: string, ...a: unknown[]) => ((one(sql, ...a) as Row)?.n ?? 0) as number;
  return {
    problems: c("SELECT count(*) n FROM problems"),
    excluded: c("SELECT count(*) n FROM excluded_problems"),
    byState: all("SELECT state, count(*) n FROM problems GROUP BY state").reduce<Record<string, number>>((m, r) => ((m[r.state] = r.n), m), {}),
    activeProblems: c("SELECT count(DISTINCT problem_id) n FROM leases WHERE released_at IS NULL"),
    touched: c("SELECT count(*) n FROM problems WHERE attempts>0"),
    posts: c("SELECT count(*) n FROM posts"),
    agentPosts: c("SELECT count(*) n FROM posts WHERE author_type='agent'"),
    postsLastHour: c("SELECT count(*) n FROM posts WHERE ts>?", now() - 3600_000),
    submissions: c("SELECT count(*) n FROM submissions"),
    reviews: c("SELECT count(*) n FROM reviews"),
    reads: c("SELECT count(*) n FROM reads"),
  };
}

export { db };
