import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { one, all, run, parse, type Row } from "../db.js";
import { emit, sysEvent } from "../bus.js";
import { DEFAULTS, RUNS_DIR, now } from "../config.js";
import { pickTask, acquireLease, releaseLeases, renewLease, systemPost, expireLeases, type Task } from "../board.js";
import { attemptPrompt, reviewPrompt, resumePrompt, nudgeSubmitPrompt, nudgeReviewPrompt } from "../prompts.js";
import { execArgs, spawnCodex, isRunAlive, killGroup } from "./codex.js";
import { LineTailer, normalize, classifyError } from "./events.js";
import { emitSub, findRollout, readRollout, applyRateLimits, verifySub, watchDeviceLogin, readAuthInfo } from "./subs.js";
import { redact } from "../security.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(["completed", "failed", "interrupted", "timeout", "killed"]);

const STARS = [
  "VEGA", "LYRA", "ALTAIR", "DENEB", "RIGEL", "SIRIUS", "MIRA", "ELARA", "CASTOR", "POLLUX", "ANTARES", "SPICA",
  "CAPELLA", "ARCTURUS", "POLARIS", "MAIA", "ELECTRA", "ALCOR", "MIZAR", "NAOS", "CANOPUS", "HADAR", "ACRUX",
  "SHAULA", "ALNAIR", "ENIF", "IZAR", "KOCHAB", "MERAK", "TARAZED",
];

function newHandle(): string {
  const used = new Set(all("SELECT handle FROM agents").map((r) => r.handle as string));
  const n = all("SELECT id FROM agents").length;
  for (let i = 0; i < 400; i++) {
    const star = STARS[(n + i) % STARS.length];
    const h = `${star}-${1 + Math.floor((n + i) / STARS.length) + Math.floor(Math.random() * 9)}`;
    if (!used.has(h)) return h;
  }
  return `AGENT-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

export function agentView(a: Row) {
  const sub = one("SELECT label, email, plan, status FROM subscriptions WHERE id=?", a.sub_id);
  const cur = a.current_run_id ? one("SELECT id, kind, problem_id, submission_id, state, started_at, segment, resumes, role FROM runs WHERE id=?", a.current_run_id) : null;
  const tok = one(
    "SELECT count(*) runs, coalesce(sum(tokens_in),0) tin, coalesce(sum(tokens_out),0) tout, coalesce(sum(tokens_reasoning),0) treason, coalesce(sum(tokens_cached),0) tcache, coalesce(sum(resumes),0) resumes FROM runs WHERE agent_id=?",
    a.id,
  )!;
  const posts = (one("SELECT count(*) n FROM posts WHERE agent_id=?", a.id) as Row).n;
  return {
    id: a.id, handle: a.handle, sub_id: a.sub_id, sub_label: sub?.label, sub_plan: sub?.plan, sub_status: sub?.status,
    slot: a.slot, status: a.status, status_detail: a.status_detail, now_text: a.now_text, enabled: !!a.enabled, paused: !!a.paused,
    current: cur, restarts: a.restarts, runs: tok.runs, resumes: tok.resumes, posts,
    tokens: { in: tok.tin, out: tok.tout, reasoning: tok.treason, cached: tok.tcache },
    first_seen_board_at: a.first_seen_board_at, first_post_at: a.first_post_at, last_active_at: a.last_active_at, created_at: a.created_at,
  };
}

const AGENT_COLS = new Set(["status", "status_detail", "now_text", "current_run_id", "enabled", "paused", "last_active_at"]);
function setAgent(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields).filter((k) => AGENT_COLS.has(k));
  if (!keys.length) return;
  run(`UPDATE agents SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`, ...keys.map((k) => fields[k]), id);
  const a = one("SELECT * FROM agents WHERE id=?", id);
  if (a) emit("agent", agentView(a));
}

export function runView(r: Row) {
  const a = one("SELECT handle FROM agents WHERE id=?", r.agent_id);
  const p = r.problem_id ? one("SELECT title, domain FROM problems WHERE id=?", r.problem_id) : null;
  return {
    id: r.id, agent_id: r.agent_id, handle: a?.handle, sub_id: r.sub_id, kind: r.kind, role: r.role, reason: r.reason,
    problem_id: r.problem_id, problem_title: p?.title, domain: p?.domain, submission_id: r.submission_id,
    state: r.state, proc: r.proc, pid: r.pid, thread_id: r.thread_id, segment: r.segment, resumes: r.resumes, nudges: r.nudges,
    started_at: r.started_at, ended_at: r.ended_at, last_event_at: r.last_event_at, end_reason: r.end_reason,
    outcome: r.outcome, summary: r.summary, error: r.error, model: r.model, effort: r.effort,
    tokens: { in: r.tokens_in, out: r.tokens_out, reasoning: r.tokens_reasoning, cached: r.tokens_cached },
    events: r.events, tool_calls: r.tool_calls, commands: r.commands,
    rate_snapshot: parse(r.rate_snapshot, null),
  };
}
const emitRun = (id: string) => { const r = one("SELECT * FROM runs WHERE id=?", id); if (r) emit("run", runView(r)); };

type End = { code: number | null; signal: string | null; reason: string | null };
const rateLogged = new Map<string, number>();

class AgentLoop {
  stopped = false;
  child: ChildProcess | null = null;
  killReason: string | null = null;
  constructor(public agentId: string) {}

  get agent() { return one("SELECT * FROM agents WHERE id=?", this.agentId); }

  async loop() {
    while (!this.stopped) {
      try {
        const wait = await this.step();
        if (wait) await sleep(wait);
      } catch (e: any) {
        // The loop itself must never die: log, back off, try again.
        sysEvent("error", "agent.loop_error", `${this.agent?.handle ?? this.agentId}: ${e?.stack ?? e}`, { agent_id: this.agentId });
        setAgent(this.agentId, { status: "backoff", status_detail: "internal error, retrying in 15s" });
        await sleep(15_000);
      }
    }
  }

  /** One iteration. Returns how long to wait before the next one. */
  async step(): Promise<number> {
    const a = this.agent;
    if (!a) { this.stopped = true; return 0; }
    if (!a.enabled && !a.current_run_id) {
      setAgent(a.id, { status: "retired", status_detail: "retired" });
      this.stopped = true;
      return 0;
    }
    const s = one("SELECT * FROM subscriptions WHERE id=?", a.sub_id);
    if (!s || s.status === "detached") { setAgent(a.id, { status: "retired", status_detail: "subscription detached", enabled: 0 }); this.stopped = true; return 0; }

    let runId: string | null = a.current_run_id;
    if (runId) {
      const r = one("SELECT state FROM runs WHERE id=?", runId);
      if (!r || FINAL.has(r.state)) { runId = null; setAgent(a.id, { current_run_id: null }); }
    }
    if (!runId) {
      if (!a.enabled) return 1000;
      if (a.paused) { setAgent(a.id, { status: "paused", status_detail: "paused by operator" }); return 3000; }
      const gate = gateFor(s);
      if (gate) { setAgent(a.id, { status: "waiting", status_detail: gate.detail }); return gate.wait; }
      const task = pickTask(a.id);
      if (!task) { setAgent(a.id, { status: "idle", status_detail: "no open task" }); return 60_000; }
      runId = this.createRun(a, s, task);
    } else {
      // A run is in flight (or needs another process). Do not let a quota gate kill it,
      // but do not start a new process while the subscription cannot serve one.
      const r = one("SELECT proc FROM runs WHERE id=?", runId)!;
      const gate = gateFor(s);
      if (r.proc === "pending" && gate) { setAgent(a.id, { status: "waiting", status_detail: gate.detail }); return gate.wait; }
    }
    const end = await this.drive(runId);
    return this.settle(runId, end);
  }

  createRun(a: Row, s: Row, task: Task): string {
    const id = "run_" + crypto.randomBytes(6).toString("hex");
    const token = crypto.randomBytes(24).toString("base64url");
    const dir = path.join(RUNS_DIR, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, "work"), { recursive: true, mode: 0o700 });
    const role = task.kind === "review" ? "reviewer" : task.role;
    run(
      `INSERT INTO runs(id,agent_id,sub_id,kind,problem_id,submission_id,state,token,dir,started_at,model,effort,proc,role,reason)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, a.id, s.id, task.kind, task.problem_id, task.kind === "review" ? task.submission_id : null, "starting", token, dir, now(),
      s.model, s.effort, "pending", role, task.reason,
    );
    acquireLease(a.id, id, task.problem_id, task.kind, role);
    run("UPDATE agents SET current_run_id=?, runs=runs+1 WHERE id=?", id, a.id);
    const p = one("SELECT id, title FROM problems WHERE id=?", task.problem_id)!;
    const msg = task.kind === "review"
      ? `@${a.handle} is reviewing S${task.submission_id} on #${p.id} (${p.title}).`
      : task.role === "partner"
        ? `@${a.handle} joined ${task.partner_handles.map((h) => "@" + h).join(", ")} on #${p.id} (${p.title}) as a partner.`
        : `@${a.handle} picked up #${p.id} (${p.title}): ${task.reason}.`;
    systemPost("coordination", task.kind === "review" ? "review" : "claim", msg, null, { problem_id: p.id, run_id: id, agent: a.handle, role });
    sysEvent("info", "run.created", `${a.handle} → #${p.id} (${task.kind}${task.kind === "attempt" ? ", " + task.role : ""})`, { agent_id: a.id, sub_id: s.id, run_id: id, problem_id: p.id });
    emitRun(id);
    return id;
  }

  initialPrompt(r: Row): string {
    const a = this.agent!;
    const p = one("SELECT * FROM problems WHERE id=?", r.problem_id)!;
    if (r.kind === "review") {
      const sub = one("SELECT * FROM submissions WHERE id=?", r.submission_id)!;
      const author = one("SELECT handle FROM agents WHERE id=?", sub.agent_id)!.handle;
      return reviewPrompt({ handle: a.handle, problem: p, submission: sub, author });
    }
    const partners = all("SELECT a.handle FROM leases l JOIN agents a ON a.id=l.agent_id WHERE l.problem_id=? AND l.released_at IS NULL AND l.agent_id!=?", r.problem_id, a.id).map((x) => x.handle);
    return attemptPrompt({ handle: a.handle, problem: p, role: r.role === "partner" ? "partner" : "lead", partners, reason: r.reason ?? "" });
  }

  /** Make sure a codex process exists for this run (spawn or re-attach), stream its events, return when it ends. */
  async drive(runId: string): Promise<End> {
    let r = one("SELECT * FROM runs WHERE id=?", runId)!;
    const a = this.agent!;
    const s = one("SELECT * FROM subscriptions WHERE id=?", r.sub_id)!;
    const outFile = path.join(r.dir, "events.jsonl");
    const errFile = path.join(r.dir, "stderr.log");
    let exit: End = { code: null, signal: null, reason: null };
    this.killReason = null;

    if (r.proc === "live" && isRunAlive(r.pid, r.dir)) {
      sysEvent("ok", "run.reattached", `Re-attached to ${a.handle}'s running process (pid ${r.pid}) after a hub restart`, { agent_id: a.id, run_id: r.id, problem_id: r.problem_id });
    } else if (r.proc === "live") {
      // The process ended while nobody was watching (hub was down). Read what it wrote, then settle.
      sysEvent("warn", "run.ended_unwatched", `${a.handle}'s process ended while the hub was down; reading its output`, { agent_id: a.id, run_id: r.id });
      const tailer = new LineTailer(outFile, r.out_offset);
      this.consume(r.id, tailer);
      run("UPDATE runs SET out_offset=? WHERE id=?", tailer.committed, r.id);
      this.scanRollout(r.id);
      // No reason: settle() judges from what the process wrote (a finished turn is a clean finish).
      return { code: null, signal: null, reason: null };
    } else {
      const resumeThread = r.segment > 0 && r.thread_id ? r.thread_id : null;
      const prompt = resumeThread ? (r.pending_prompt ?? resumePrompt("unknown")) : this.initialPrompt(r);
      const promptFile = path.join(r.dir, `prompt-${r.segment}.md`);
      fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
      const args = execArgs({ workDir: path.join(r.dir, "work"), model: r.model, effort: r.effort, token: r.token, resumeThread });
      fs.writeFileSync(path.join(r.dir, `launch-${r.segment}.json`), JSON.stringify({ argv: ["codex", ...args].map((x) => x.replace(r.token, "<run-token>")), codex_home: s.home, at: now() }, null, 2), { mode: 0o600 });
      const child = spawnCodex({ args, cwd: path.join(r.dir, "work"), home: s.home, promptFile, outFile, errFile });
      this.child = child;
      child.on("exit", (code, signal) => { exit = { ...exit, code, signal }; });
      child.on("error", (e) => sysEvent("error", "run.spawn_error", `${a.handle}: ${e.message}`, { agent_id: a.id, run_id: r.id }));
      const ts = now();
      run("UPDATE runs SET pid=?, proc='live', state='running', seg_started_at=?, last_event_at=?, pending_prompt=NULL, seg_state='{}' WHERE id=?", child.pid ?? null, ts, ts, r.id);
      this.event(r.id, { kind: "system", data: { message: resumeThread ? `segment ${r.segment} started: resumed codex thread ${resumeThread}` : "process started", pid: child.pid, segment: r.segment } });
      sysEvent(resumeThread ? "ok" : "info", resumeThread ? "run.resumed" : "run.started",
        resumeThread ? `${a.handle} resumed its session on #${r.problem_id} (restart ${r.resumes})` : `${a.handle} started on #${r.problem_id} (pid ${child.pid})`,
        { agent_id: a.id, sub_id: s.id, run_id: r.id, problem_id: r.problem_id });
      emitRun(r.id);
    }
    r = one("SELECT * FROM runs WHERE id=?", runId)!;
    setAgent(a.id, { status: "running", status_detail: r.kind === "review" ? `reviewing S${r.submission_id}` : `working #${r.problem_id}`, last_active_at: now() });

    const tailer = new LineTailer(outFile, r.out_offset);
    let lastPersist = 0, lastRollout = 0;
    while (true) {
      await sleep(700);
      this.consume(r.id, tailer);
      const t = now();
      if (t - lastPersist > 3000) { run("UPDATE runs SET out_offset=? WHERE id=?", tailer.committed, r.id); lastPersist = t; }
      if (t - lastRollout > 10_000) { this.scanRollout(r.id); lastRollout = t; }
      const cur = one("SELECT pid, dir, last_event_at, seg_started_at, started_at FROM runs WHERE id=?", r.id)!;
      const alive = this.child && this.child.pid === cur.pid ? this.child.exitCode === null && this.child.signalCode === null : isRunAlive(cur.pid, cur.dir);
      if (!alive) {
        await sleep(400);
        this.consume(r.id, tailer);
        run("UPDATE runs SET out_offset=? WHERE id=?", tailer.committed, r.id);
        this.scanRollout(r.id);
        break;
      }
      if (this.killReason) {
        killGroup(cur.pid, "SIGTERM");
        await sleep(3000);
        if (isRunAlive(cur.pid, cur.dir)) killGroup(cur.pid, "SIGKILL");
        continue;
      }
      if (t - (cur.last_event_at ?? t) > DEFAULTS.stallMin * 60_000) {
        this.killReason = "stalled: no events for " + DEFAULTS.stallMin + " min";
        sysEvent("warn", "run.stalled", `${a.handle} produced no events for ${DEFAULTS.stallMin} min; restarting its process`, { agent_id: a.id, run_id: r.id });
      } else if (t - cur.started_at > DEFAULTS.runHardLimitMin * 60_000) {
        this.killReason = "timeout";
        sysEvent("warn", "run.timeout", `${a.handle} hit the ${DEFAULTS.runHardLimitMin} min limit on #${r.problem_id}; stopping`, { agent_id: a.id, run_id: r.id });
      }
    }
    this.child = null;
    if (!exit.reason) exit.reason = this.killReason;
    return exit;
  }

  /** Read new codex output, store it, and push it to the browser. */
  consume(runId: string, tailer: LineTailer) {
    const lines = tailer.read();
    if (!lines.length) return;
    const r = one("SELECT * FROM runs WHERE id=?", runId)!;
    const seg = parse<Row>(r.seg_state, {});
    let detail: string | null = null;
    for (const line of lines) {
      const ev = normalize(line);
      if (!ev) continue;
      if (ev.kind === "thread") {
        if (!r.thread_id) run("UPDATE runs SET thread_id=? WHERE id=?", ev.data.thread_id, runId);
        r.thread_id = r.thread_id ?? ev.data.thread_id;
        continue;
      }
      if (ev.kind === "turn") continue;
      if (ev.kind === "usage") {
        seg.turn_completed = true;
        const u = ev.data.usage as Row;
        if (!r.rollout_path) {
          run("UPDATE runs SET tokens_in=tokens_in+?, tokens_out=tokens_out+?, tokens_reasoning=tokens_reasoning+?, tokens_cached=tokens_cached+? WHERE id=?",
            u.input_tokens ?? 0, u.output_tokens ?? 0, u.reasoning_output_tokens ?? 0, u.cached_input_tokens ?? 0, runId);
        }
      }
      if (ev.kind === "error" || ev.kind === "failed") {
        const msg = String(ev.data.message ?? "");
        // Codex logs a harmless warning when model metadata is missing; do not treat it as a failure.
        if (!/Model metadata for/.test(msg)) seg.last_error = msg;
        if (ev.kind === "failed") seg.failed = true;
      }
      if (ev.kind === "reasoning") {
        const title = String(ev.data.text ?? "").match(/\*\*(.+?)\*\*/)?.[1];
        if (title) detail = title;
      } else if (ev.kind === "tool" && ev.status !== "in_progress") {
        detail = `board: ${String(ev.data.tool).replace(/^board_/, "")}`;
      } else if (ev.kind === "command" && ev.status === "in_progress") {
        detail = "running a computation";
      } else if (ev.kind === "search") {
        detail = "searching the literature";
      }
      this.event(runId, { ...ev, item_id: ev.item_id ? `${r.segment}:${ev.item_id}` : undefined });
    }
    run("UPDATE runs SET seg_state=?, last_event_at=? WHERE id=?", JSON.stringify(seg), now(), runId);
    renewLease(runId);
    if (detail) setAgent(this.agentId, { status_detail: detail, last_active_at: now() });
  }

  /** Store one event (upserting started → completed items) and broadcast it. */
  event(runId: string, ev: { kind: string; item_id?: string; status?: string; data: Record<string, unknown> }) {
    const ts = now();
    const existing = ev.item_id ? one("SELECT id, seq FROM run_events WHERE run_id=? AND item_id=?", runId, ev.item_id) : undefined;
    let seq: number;
    if (existing) {
      seq = existing.seq;
      run("UPDATE run_events SET status=?, data=?, ts=? WHERE id=?", ev.status ?? null, JSON.stringify(ev.data), ts, existing.id);
    } else {
      seq = ((one("SELECT max(seq) m FROM run_events WHERE run_id=?", runId) as Row).m ?? 0) + 1;
      run("INSERT INTO run_events(run_id,seq,ts,kind,item_id,status,data) VALUES(?,?,?,?,?,?,?)", runId, seq, ts, ev.kind, ev.item_id ?? null, ev.status ?? null, JSON.stringify(ev.data));
      run("UPDATE runs SET events=events+1 WHERE id=?", runId);
    }
    if (ev.status !== "in_progress") {
      if (ev.kind === "tool") run("UPDATE runs SET tool_calls=tool_calls+1 WHERE id=?", runId);
      if (ev.kind === "command") run("UPDATE runs SET commands=commands+1 WHERE id=?", runId);
    }
    emit("run.event", { run_id: runId, agent_id: this.agentId, seq, ts, kind: ev.kind, item_id: ev.item_id ?? null, status: ev.status ?? null, data: ev.data });
    // A light summary for everyone (ticker, field pulses); the full event only goes to inspectors.
    if (!existing || ev.status !== "in_progress") {
      const label = ev.kind === "tool" ? String(ev.data.tool ?? "") : ev.kind === "reasoning" ? (String(ev.data.text ?? "").match(/\*\*(.+?)\*\*/)?.[1] ?? "thinking")
        : ev.kind === "command" ? "computation" : ev.kind === "search" ? `search: ${String(ev.data.query ?? "").slice(0, 60)}` : ev.kind;
      emit("activity", { run_id: runId, agent_id: this.agentId, kind: ev.kind, status: ev.status ?? null, label, ts });
    }
  }

  scanRollout(runId: string) {
    const r = one("SELECT * FROM runs WHERE id=?", runId)!;
    if (!r.thread_id) return;
    const s = one("SELECT home FROM subscriptions WHERE id=?", r.sub_id)!;
    let rp = r.rollout_path;
    if (!rp) {
      rp = findRollout(s.home, r.thread_id);
      if (!rp) return;
      run("UPDATE runs SET rollout_path=? WHERE id=?", rp, runId);
    }
    const { rate, usage, offset } = readRollout(rp, r.rollout_offset);
    if (offset !== r.rollout_offset) run("UPDATE runs SET rollout_offset=? WHERE id=?", offset, runId);
    if (usage) {
      run("UPDATE runs SET tokens_in=?, tokens_out=?, tokens_reasoning=?, tokens_cached=? WHERE id=?",
        usage.input_tokens ?? 0, usage.output_tokens ?? 0, usage.reasoning_output_tokens ?? 0, usage.cached_input_tokens ?? 0, runId);
      emitRun(runId);
    }
    if (rate) {
      applyRateLimits(r.sub_id, rate);
      run("UPDATE runs SET rate_snapshot=? WHERE id=?", JSON.stringify({ ...rate, seen_at: now() }), runId);
    }
  }

  /** Decide what happens after a process ends. Returns ms to wait before the next step. */
  settle(runId: string, end: End): number {
    const r = one("SELECT * FROM runs WHERE id=?", runId)!;
    const a = this.agent!;
    const seg = parse<Row>(r.seg_state, {});
    run("UPDATE runs SET proc='pending', pid=NULL WHERE id=?", runId);
    const delivered = r.kind === "review"
      ? !!one("SELECT id FROM reviews WHERE run_id=?", runId)
      : !!one("SELECT id FROM submissions WHERE run_id=?", runId);

    // 1. Clean finish.
    if (seg.turn_completed && !seg.failed && !end.reason) {
      if (!delivered && r.nudges < 1) {
        run("UPDATE runs SET segment=segment+1, nudges=nudges+1, pending_prompt=? WHERE id=?", r.kind === "review" ? nudgeReviewPrompt : nudgeSubmitPrompt, runId);
        sysEvent("info", "run.nudged", `${a.handle} ended without ${r.kind === "review" ? "a review" : "a submission"}; asking it to file one`, { agent_id: a.id, run_id: runId });
        return 1500;
      }
      this.finalize(runId, "completed", delivered ? null : "ended without filing a result");
      return 3000;
    }

    // 2. Something went wrong. Work out what.
    const stderrTail = (() => { try { return redact(fs.readFileSync(path.join(r.dir, "stderr.log"), "utf8").slice(-4000)); } catch { return ""; } })();
    const errText = redact([seg.last_error, end.reason, stderrTail.split("\n").filter((l) => /ERROR|error:/.test(l)).slice(-3).join(" ")].filter(Boolean).join(" | "));
    if (end.reason?.startsWith("operator")) {
      this.finalize(runId, "killed", end.reason);
      return 3000;
    }
    if (end.reason?.startsWith("usage limit")) seg.last_error = end.reason;
    const killedByUs = end.reason && /stalled|timeout/.test(end.reason);
    const cls = killedByUs ? "transient" : seg.last_error ? classifyError(seg.last_error) : end.signal ? "transient" : classifyError(errText || "process exited unexpectedly");
    const s = one("SELECT * FROM subscriptions WHERE id=?", r.sub_id)!;

    if (cls === "usage_limit") {
      const rl = parse<Row>(s.rate_limits, {});
      const resets = Math.max(...[rl.primary?.resets_at, rl.secondary?.resets_at].filter(Boolean).map((x: number) => x * 1000), 0);
      const until = s.status === "rate_limited" && s.paused_until > now() ? s.paused_until : resets > now() ? resets : now() + 30 * 60_000;
      run("UPDATE subscriptions SET status='rate_limited', paused_until=?, error=coalesce(error, ?) WHERE id=?", until, String(seg.last_error).slice(0, 300), s.id);
      emitSub(s.id);
      // Several agents on one subscription hit the limit together; report it once per pause.
      if (rateLogged.get(s.id) !== until) {
        rateLogged.set(s.id, until);
        sysEvent("warn", "sub.rate_limited", `"${s.label}" hit its usage limit; its agents pause until ${new Date(until).toISOString().slice(11, 16)} UTC. Other subscriptions keep running.`, { sub_id: s.id, run_id: runId });
      }
      this.finalize(runId, "interrupted", "subscription usage limit");
      return 5000;
    }
    if (cls === "auth") {
      run("UPDATE subscriptions SET status='auth_error', error=? WHERE id=?", String(seg.last_error ?? errText).slice(0, 300), s.id);
      emitSub(s.id);
      sysEvent("error", "sub.auth_error", `"${s.label}" can no longer sign in: ${String(seg.last_error ?? errText).slice(0, 160)}. Re-attach it to continue.`, { sub_id: s.id, run_id: runId });
      this.finalize(runId, "failed", "subscription sign-in failed");
      return 10_000;
    }
    if (end.reason === "timeout") {
      if (!delivered && r.nudges < 1) {
        run("UPDATE runs SET segment=segment+1, nudges=nudges+1, pending_prompt=?, started_at=? WHERE id=?",
          `[Agora supervisor] You have used your time on this problem. Stop exploring and call ${r.kind === "review" ? "board_review" : "board_submit"} now with what you have.`, now() - (DEFAULTS.runHardLimitMin - 15) * 60_000, runId);
        return 1500;
      }
      this.finalize(runId, "timeout", "hit the time limit");
      return 3000;
    }
    if (r.resumes < DEFAULTS.maxResumes) {
      const why = end.reason ?? (end.signal ? `killed by ${end.signal}` : seg.last_error ? String(seg.last_error).slice(0, 120) : "process exited unexpectedly");
      const backoff = Math.min(60_000, 4000 * 2 ** r.resumes);
      run("UPDATE runs SET segment=segment+1, resumes=resumes+1, pending_prompt=? WHERE id=?", resumePrompt(why), runId);
      run("UPDATE agents SET restarts=restarts+1 WHERE id=?", a.id);
      setAgent(a.id, { status: "backoff", status_detail: `restarting in ${Math.round(backoff / 1000)}s: ${why}` });
      sysEvent("warn", "run.crashed", `${a.handle}'s process ended (${why}); resuming the same session in ${Math.round(backoff / 1000)}s (restart ${r.resumes + 1}/${DEFAULTS.maxResumes})`, { agent_id: a.id, run_id: runId, problem_id: r.problem_id }, { class: cls, signal: end.signal, code: end.code });
      emitRun(runId);
      return backoff;
    }
    this.finalize(runId, "failed", `gave up after ${r.resumes} restarts: ${errText.slice(0, 200)}`);
    return 20_000;
  }

  finalize(runId: string, state: string, note: string | null) {
    const r = one("SELECT * FROM runs WHERE id=?", runId)!;
    const a = this.agent!;
    const sub = one("SELECT outcome, summary FROM submissions WHERE run_id=?", runId);
    const rev = one("SELECT verdict FROM reviews WHERE run_id=?", runId);
    const outcome = sub?.outcome ?? (rev ? `review:${rev.verdict}` : null);
    run("UPDATE runs SET state=?, proc='done', ended_at=?, outcome=?, summary=?, end_reason=?, error=CASE WHEN ?='completed' THEN NULL ELSE ? END WHERE id=?",
      state, now(), outcome, sub?.summary ?? null, note, state, note, runId);
    releaseLeases(runId, state);
    if (state !== "completed" || !outcome) {
      systemPost("coordination", "handoff",
        `@${a.handle}'s session on #${r.problem_id} ended (${note ?? state}). Its notes so far are in the thread; the problem is free for pickup.`,
        null, { problem_id: r.problem_id, run_id: runId });
    }
    setAgent(a.id, { current_run_id: null, status: "idle", status_detail: `finished #${r.problem_id}: ${outcome ?? state}` });
    sysEvent(state === "completed" ? "ok" : "warn", `run.${state}`, `${a.handle} ${state} #${r.problem_id}${outcome ? ` → ${outcome}` : ""}${note ? ` (${note})` : ""}`, { agent_id: a.id, run_id: runId, problem_id: r.problem_id });
    emitRun(runId);
  }
}

/** Is the subscription able to serve a new codex process right now? */
function gateFor(s: Row): { detail: string; wait: number } | null {
  switch (s.status) {
    case "pending_auth": return { detail: "waiting for the owner to finish sign-in", wait: 5000 };
    case "verifying": return { detail: "verifying the subscription", wait: 3000 };
    case "auth_error": return { detail: "subscription needs a new sign-in", wait: 30_000 };
    case "paused": return { detail: "subscription paused by its owner", wait: 5000 };
    case "rate_limited": {
      if (s.paused_until && s.paused_until > now()) {
        return { detail: `usage limit reached; resumes ${new Date(s.paused_until).toISOString().slice(11, 16)} UTC`, wait: Math.min(60_000, s.paused_until - now()) };
      }
      run("UPDATE subscriptions SET status='active', paused_until=NULL, error=NULL WHERE id=?", s.id);
      emitSub(s.id);
      sysEvent("ok", "sub.resumed", `"${s.label}" usage window reset; its agents resume`, { sub_id: s.id });
      return null;
    }
  }
  const rl = parse<Row | null>(s.rate_limits, null);
  if (rl) {
    const used = Math.max(rl.primary?.used_percent ?? 0, rl.secondary?.used_percent ?? 0);
    if (used >= s.reserve_pct) {
      const resets = Math.max(...[rl.primary?.resets_at, rl.secondary?.resets_at].filter(Boolean).map((x: number) => x * 1000), 0);
      if (!resets || resets > now()) return { detail: `quota reserve: ${used.toFixed(0)}% used, owner keeps the last ${100 - s.reserve_pct}%`, wait: 60_000 };
    }
  }
  return null;
}

export class Supervisor {
  loops = new Map<string, AgentLoop>();

  start() {
    this.reconcile();
    for (const a of all("SELECT * FROM agents WHERE status!='retired'")) this.startLoop(a.id);
    setInterval(() => { try { expireLeases(); } catch (e) { console.error(e); } }, 20_000).unref();
    setInterval(() => { try { this.ensureAll(); } catch (e) { console.error(e); } }, 15_000).unref();
    setInterval(() => { void this.healthChecks(); }, 5 * 60_000).unref();
    this.ensureAll();
  }

  /** After a hub restart: re-adopt live processes, notice ones that died, resume device logins. */
  reconcile() {
    const live = all("SELECT * FROM runs WHERE state NOT IN ('completed','failed','interrupted','timeout','killed')");
    let alive = 0;
    for (const r of live) if (r.proc === "live" && isRunAlive(r.pid, r.dir)) alive++;
    if (live.length) sysEvent("info", "hub.reconcile", `Hub started: ${live.length} unfinished run(s), ${alive} still running and being re-attached`, {}, { runs: live.map((r) => r.id) });
    for (const s of all("SELECT id FROM subscriptions WHERE status='pending_auth'")) watchDeviceLogin(s.id);
    for (const s of all("SELECT id FROM subscriptions WHERE status='verifying'")) void verifySub(s.id);
  }

  startLoop(agentId: string) {
    if (this.loops.has(agentId)) return;
    const loop = new AgentLoop(agentId);
    this.loops.set(agentId, loop);
    void loop.loop().finally(() => this.loops.delete(agentId));
  }

  /** Match the number of agents on each subscription to its target. */
  ensureAll() {
    for (const s of all("SELECT * FROM subscriptions WHERE status IN ('active','rate_limited','paused')")) {
      const agents = all("SELECT * FROM agents WHERE sub_id=? AND status!='retired' ORDER BY slot", s.id);
      const enabled = agents.filter((a) => a.enabled);
      if (enabled.length < s.agents_target) {
        for (let i = enabled.length; i < s.agents_target; i++) {
          const id = "agt_" + crypto.randomBytes(5).toString("hex");
          const handle = newHandle();
          const slot = (all("SELECT max(slot) m FROM agents WHERE sub_id=?", s.id)[0]?.m ?? -1) + 1;
          run("INSERT INTO agents(id,handle,sub_id,slot,status,created_at) VALUES(?,?,?,?,?,?)", id, handle, s.id, slot, "idle", now());
          sysEvent("ok", "agent.spawned", `New agent ${handle} on "${s.label}"`, { agent_id: id, sub_id: s.id });
          emit("agent", agentView(one("SELECT * FROM agents WHERE id=?", id)!));
          this.startLoop(id);
        }
      } else if (enabled.length > s.agents_target) {
        const extra = enabled.slice(s.agents_target).reverse();
        for (const a of extra.slice(0, enabled.length - s.agents_target)) {
          setAgent(a.id, { enabled: 0, status: a.current_run_id ? a.status : "retired", status_detail: a.current_run_id ? "retiring after this run" : "retired" });
          sysEvent("info", "agent.retiring", `${a.handle} will retire${a.current_run_id ? " after its current run" : ""}`, { agent_id: a.id, sub_id: s.id });
        }
      }
      for (const a of agents) if (!this.loops.has(a.id) && (a.enabled || a.current_run_id)) this.startLoop(a.id);
    }
    // Agents that were retired but still had a run: once the run is done, mark retired.
    for (const a of all("SELECT * FROM agents WHERE enabled=0 AND current_run_id IS NULL AND status!='retired'")) {
      setAgent(a.id, { status: "retired", status_detail: "retired" });
    }
  }

  async healthChecks() {
    for (const s of all("SELECT * FROM subscriptions WHERE status IN ('active','auth_error')")) {
      const info = readAuthInfo(path.join(s.home, "auth.json"));
      if (info.access_expires_at) run("UPDATE subscriptions SET token_expires_at=? WHERE id=?", info.access_expires_at, s.id);
      if (!s.verified_at || now() - s.verified_at > 30 * 60_000) await verifySub(s.id);
    }
  }

  /** Chaos: SIGKILL a running codex process. The agent loop should notice and resume the session. */
  chaosKill(agentId?: string) {
    const cands = all("SELECT r.*, a.handle FROM runs r JOIN agents a ON a.id=r.agent_id WHERE r.proc='live' AND r.state='running'" + (agentId ? " AND r.agent_id=?" : ""), ...(agentId ? [agentId] : []));
    if (!cands.length) return null;
    const r = cands[Math.floor(Math.random() * cands.length)];
    sysEvent("warn", "chaos.kill", `Chaos: sent SIGKILL to ${r.handle}'s codex process (pid ${r.pid})`, { agent_id: r.agent_id, run_id: r.id, problem_id: r.problem_id });
    killGroup(r.pid, "SIGKILL");
    return { run_id: r.id, handle: r.handle, pid: r.pid };
  }

  /** Chaos: behave as if a subscription just hit its usage limit (its sessions end, it pauses, then resumes by itself). */
  chaosQuota(subId: string, seconds: number) {
    const s = one("SELECT * FROM subscriptions WHERE id=?", subId);
    if (!s) return null;
    const until = now() + seconds * 1000;
    run("UPDATE subscriptions SET status='rate_limited', paused_until=?, error=? WHERE id=?", until, `simulated usage limit for ${seconds}s (chaos test)`, subId);
    emitSub(subId);
    sysEvent("warn", "chaos.quota", `Chaos: "${s.label}" behaves as if it hit its usage limit for ${seconds}s. Its sessions end and free their problems; other subscriptions are untouched; it resumes by itself.`, { sub_id: subId });
    for (const r of all("SELECT * FROM runs WHERE sub_id=? AND proc='live'", subId)) {
      const loop = this.loops.get(r.agent_id);
      if (loop) loop.killReason = "usage limit reached (simulated)";
    }
    return { until };
  }

  stopRun(runId: string, reason = "operator stopped the run") {
    const r = one("SELECT * FROM runs WHERE id=?", runId);
    if (!r) return false;
    const loop = this.loops.get(r.agent_id);
    if (loop) loop.killReason = reason;
    return true;
  }
}

export const supervisor = new Supervisor();
