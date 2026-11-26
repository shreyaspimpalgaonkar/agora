import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { DATA_DIR, ROOT } from "./config.js";

const dbPath = path.join(DATA_DIR, "agora.db");
export const db = new Database(dbPath);
try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort */ }
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY,           -- rank in the ProofAtlas 2026-10-06 edition
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  question TEXT, why TEXT,
  domain TEXT NOT NULL, domain_label TEXT NOT NULL, family TEXT,
  atlas_status TEXT, atlas_note TEXT, openai_partial INTEGER DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'open', -- open | active | explored | partial | claimed | verified | contested
  attempts INTEGER NOT NULL DEFAULT 0,
  posts INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER
);
CREATE TABLE IF NOT EXISTS excluded_problems (
  id INTEGER PRIMARY KEY, slug TEXT, title TEXT, domain TEXT, domain_label TEXT,
  outcome TEXT, note TEXT, meta TEXT
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  owner TEXT,
  source TEXT NOT NULL,              -- device | import
  source_path TEXT,                  -- for import: the auth file the login is shared with
  home TEXT NOT NULL,                -- CODEX_HOME for every agent of this subscription
  status TEXT NOT NULL,              -- pending_auth | verifying | active | paused | rate_limited | auth_error | detached
  email TEXT, plan TEXT, account_hash TEXT, token_expires_at INTEGER,
  agents_target INTEGER NOT NULL DEFAULT 2,
  model TEXT NOT NULL, effort TEXT NOT NULL,
  reserve_pct INTEGER NOT NULL DEFAULT 80,
  rate_limits TEXT,                  -- json, from the newest token_count event
  rate_checked_at INTEGER,
  verified_at INTEGER, verify_detail TEXT,
  device TEXT,                       -- json: {url, code, expires_at, pid}
  paused_until INTEGER,
  error TEXT,
  manage_token TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,
  sub_id TEXT NOT NULL REFERENCES subscriptions(id),
  slot INTEGER NOT NULL,
  status TEXT NOT NULL,              -- idle | starting | running | waiting | backoff | paused | retired
  status_detail TEXT,
  now_text TEXT,                     -- the agent's own "what I'm doing" line
  current_run_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,  -- 0 = retiring or retired
  paused INTEGER NOT NULL DEFAULT 0,   -- 1 = operator paused this agent (it finishes its current run first)
  restarts INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cached INTEGER NOT NULL DEFAULT 0,
  first_seen_board_at INTEGER, first_post_at INTEGER,
  last_active_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  sub_id TEXT NOT NULL,
  kind TEXT NOT NULL,                -- attempt | review | probe
  problem_id INTEGER,
  submission_id INTEGER,
  state TEXT NOT NULL,               -- starting | running | completed | failed | interrupted | timeout | killed
  token TEXT UNIQUE NOT NULL,
  pid INTEGER,
  thread_id TEXT,
  dir TEXT NOT NULL,
  segment INTEGER NOT NULL DEFAULT 0, -- 0 = first process, 1.. = resumes of the same codex thread
  out_offset INTEGER NOT NULL DEFAULT 0,
  rollout_path TEXT, rollout_offset INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  last_event_at INTEGER,
  exit_code INTEGER,
  outcome TEXT, summary TEXT, error TEXT,
  model TEXT, effort TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cached INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  commands INTEGER NOT NULL DEFAULT 0,
  proc TEXT NOT NULL DEFAULT 'pending', -- pending (needs a process) | live (process running) | done
  resumes INTEGER NOT NULL DEFAULT 0,   -- restarts after crashes, kills, stalls
  nudges INTEGER NOT NULL DEFAULT 0,    -- follow-up turns asking for a missing submit/review
  pending_prompt TEXT,
  seg_state TEXT NOT NULL DEFAULT '{}', -- per-process facts: turn_completed, last_error
  seg_started_at INTEGER,
  end_reason TEXT,
  role TEXT,
  reason TEXT,
  rate_snapshot TEXT                 -- newest quota report seen inside this session (proves which plan it ran on)
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, started_at);
CREATE INDEX IF NOT EXISTS runs_state ON runs(state);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                -- message | reasoning | command | tool | search | file_change | plan | error | usage | failed | system
  item_id TEXT,
  status TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id, seq);
CREATE INDEX IF NOT EXISTS run_events_item ON run_events(run_id, item_id);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  channel TEXT NOT NULL,             -- general | coordination | results | reviews | problem | dm
  problem_id INTEGER,
  parent_id INTEGER,
  author_type TEXT NOT NULL,         -- agent | human | system
  agent_id TEXT,
  run_id TEXT,
  author_name TEXT,
  kind TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  to_agent_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS posts_problem ON posts(problem_id, id);
CREATE INDEX IF NOT EXISTS posts_channel ON posts(channel, id);
CREATE INDEX IF NOT EXISTS posts_agent ON posts(agent_id, id);
CREATE INDEX IF NOT EXISTS posts_parent ON posts(parent_id);
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(title, body, content='posts', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, title, body) VALUES (new.id, coalesce(new.title,''), new.body);
END;
CREATE TABLE IF NOT EXISTS reads (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  target TEXT NOT NULL,              -- thread:<problem> | feed | inbox | search | submission:<id> | problem:<id>
  post_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS reads_agent ON reads(agent_id, ts);
CREATE TABLE IF NOT EXISTS leases (
  id INTEGER PRIMARY KEY,
  problem_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,                -- attempt | review
  role TEXT,                         -- lead | partner | reviewer
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS leases_open ON leases(released_at, problem_id);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  outcome TEXT NOT NULL,             -- solved | disproved | partial | no_progress
  summary TEXT NOT NULL,
  writeup TEXT NOT NULL,
  handoff TEXT,
  review_state TEXT NOT NULL,        -- none | pending | accepted | rejected | contested
  accepts INTEGER NOT NULL DEFAULT 0,
  rejects INTEGER NOT NULL DEFAULT 0,
  post_id INTEGER
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  submission_id INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  verdict TEXT NOT NULL,             -- accept | reject | needs_work
  body TEXT NOT NULL,
  post_id INTEGER
);
CREATE TABLE IF NOT EXISTS sys_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,               -- info | ok | warn | error
  kind TEXT NOT NULL,
  agent_id TEXT, sub_id TEXT, run_id TEXT, problem_id INTEGER,
  message TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sys_events_ts ON sys_events(ts);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

// Columns added after the first deploy.
for (const [table, col, type] of [["runs", "rate_snapshot", "TEXT"]] as const) {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

export function kvGet<T>(k: string, dflt: T): T {
  const row = db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined;
  return row ? (JSON.parse(row.v) as T) : dflt;
}
export function kvSet(k: string, v: unknown) {
  db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, JSON.stringify(v));
}

/** Twelve working domains. ProofAtlas has a few one-off labels that we fold into the nearest big one. */
const DOMAIN_FOLD: Record<string, [string, string]> = {
  "Group theory": ["algebra", "Algebra, representation & category theory"],
  "Representation theory": ["algebra", "Algebra, representation & category theory"],
  "Algebra & logic": ["logic", "Logic, foundations & set theory"],
  Analysis: ["analysis", "Analysis & PDE"],
  "Algebraic geometry": ["geometry", "Geometry & topology"],
};
const DOMAIN_KEYS: Record<string, string> = {
  "Number theory & arithmetic geometry": "number",
  "Theoretical computer science": "tcs",
  "Geometry & topology": "geometry",
  "Algebra, representation & category theory": "algebra",
  "Analysis & PDE": "analysis",
  "Combinatorics & discrete geometry": "combinatorics",
  "Probability, ergodic theory & dynamics": "probability",
  "Cryptography, coding, information & optimization": "crypto",
  "Logic, foundations & set theory": "logic",
  "Mathematical physics": "physics",
  "Quantum information & computation": "quantum",
  "Applied & computational mathematics": "applied",
};

export function seedProblems() {
  const have = (db.prepare("SELECT count(*) n FROM problems").get() as { n: number }).n;
  if (have > 0) return;
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "problems.json"), "utf8"));
  const ins = db.prepare(`INSERT INTO problems(id,slug,title,statement,question,why,domain,domain_label,family,atlas_status,atlas_note,openai_partial,meta)
    VALUES(@id,@slug,@title,@statement,@question,@why,@domain,@domain_label,@family,@atlas_status,@atlas_note,@openai_partial,@meta)`);
  const insX = db.prepare(`INSERT INTO excluded_problems(id,slug,title,domain,domain_label,outcome,note,meta) VALUES(?,?,?,?,?,?,?,?)`);
  const fold = (label: string): [string, string] => DOMAIN_FOLD[label] ?? [DOMAIN_KEYS[label] ?? "applied", label];
  db.transaction(() => {
    for (const p of src.problems) {
      const [domain, domainLabel] = fold(p.domainLabel);
      ins.run({
        id: p.rank, slug: p.slug, title: p.title, statement: p.statement, question: p.question ?? null, why: p.why ?? null,
        domain, domain_label: domainLabel, family: p.family ?? null, atlas_status: p.atlasStatus ?? null,
        atlas_note: p.atlasNote ?? null, openai_partial: p.openaiPartial ? 1 : 0,
        meta: JSON.stringify({ sources: p.sources, related: p.related, consequences: p.consequences, aliases: p.aliases, formalSource: p.formalSource, atlasReviewedAt: p.atlasReviewedAt }),
      });
    }
    for (const x of src.excluded) {
      const [domain, domainLabel] = fold(x.domainLabel);
      insX.run(x.rank, x.slug, x.title, domain, domainLabel, x.outcome, x.note, JSON.stringify({ sources: x.sources }));
    }
  })();
  kvSet("dataset", src.meta);
}

export type Row = Record<string, any>;
export const one = <T = Row>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T | undefined;
export const all = <T = Row>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
export const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
export const parse = <T = any>(s: string | null | undefined, dflt: T): T => {
  if (!s) return dflt;
  try { return JSON.parse(s) as T; } catch { return dflt; }
};
