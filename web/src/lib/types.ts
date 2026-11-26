export type Role = "admin" | "viewer" | null;

export type RateLimits = {
  primary?: { used_percent: number; window_minutes: number; resets_at: number } | null;
  secondary?: { used_percent: number; window_minutes: number; resets_at: number } | null;
  plan_type?: string;
  credits?: { has_credits: boolean; unlimited: boolean; balance: string } | null;
  rate_limit_reached_type?: string | null;
};

export type Sub = {
  id: string; label: string; owner: string | null; source: "device" | "import"; status: string;
  email: string | null; plan: string | null; account_hash: string | null; token_expires_at: number | null;
  agents_target: number; model: string; effort: string; reserve_pct: number;
  rate_limits: RateLimits | null; rate_checked_at: number | null;
  verified_at: number | null;
  verify_detail: { ok: boolean; latency_ms: number; model: string; reply: string; expected: string; error: string | null; email: string; plan: string; account_hash: string; checked_at: number; access_expires_at?: number; home?: string } | null;
  device: { url: string; code?: string; expires_at: number; started_at: number } | null;
  paused_until: number | null; error: string | null; created_at: number;
  home?: string; source_path?: string;
  agents: { id: string; handle: string; status: string; status_detail: string | null; current_run_id: string | null; enabled: number }[];
  usage: { runs: number; tin: number; tout: number; treason: number; tcache: number };
};

export type Agent = {
  id: string; handle: string; sub_id: string; sub_label?: string; sub_plan?: string; sub_status?: string;
  slot: number; status: string; status_detail: string | null; now_text: string | null; enabled: boolean; paused: boolean;
  current: { id: string; kind: string; problem_id: number; submission_id: number | null; state: string; started_at: number; segment: number; resumes: number; role: string } | null;
  restarts: number; runs: number; resumes: number; posts: number;
  tokens: { in: number; out: number; reasoning: number; cached: number };
  first_seen_board_at: number | null; first_post_at: number | null; last_active_at: number | null; created_at: number;
};

export type Run = {
  id: string; agent_id: string; handle?: string; sub_id: string; kind: string; role: string | null; reason: string | null;
  problem_id: number | null; problem_title?: string; domain?: string; submission_id: number | null;
  state: string; proc: string; pid: number | null; thread_id: string | null; segment: number; resumes: number; nudges: number;
  started_at: number; ended_at: number | null; last_event_at: number | null; end_reason: string | null;
  outcome: string | null; summary: string | null; error: string | null; model: string; effort: string;
  tokens: { in: number; out: number; reasoning: number; cached: number };
  events: number; tool_calls: number; commands: number;
  rate_snapshot?: (RateLimits & { seen_at: number }) | null;
};

export type Post = {
  id: number; ts: number; channel: string; problem_id: number | null; parent_id: number | null;
  author_type: "agent" | "human" | "system"; agent_id: string | null; run_id: string | null; author: string;
  kind: string; title: string | null; body: string; mentions: string[]; to: string | null; meta: Record<string, any>;
};

export type ProblemLite = {
  id: number; slug: string; title: string; domain: string; domain_label: string; atlas_status: string | null;
  openai_partial: boolean; state: string; attempts: number; posts: number; last_activity_at: number | null;
  active: { agent_id: string; handle: string; kind: string; role: string; since: number }[];
};

export type Submission = {
  id: number; ts: number; problem_id: number; agent_id: string; run_id: string; outcome: string; summary: string; writeup: string;
  handoff: string | null; review_state: string; accepts: number; rejects: number; post_id: number | null; handle: string; title?: string;
  reviews: { id: number; ts: number; agent_id: string; verdict: string; body: string; handle: string; post_id: number | null }[];
};

export type ProblemFull = ProblemLite & {
  statement: string; question: string | null; why: string | null; family: string | null; atlas_note: string | null;
  sources?: { citation: string; url?: string; role?: string }[];
  related?: { slug: string; label: string; relation: string }[];
  consequences?: { positiveBranch?: string; negativeBranch?: string } | null;
  aliases?: string[]; atlasReviewedAt?: string;
  submissions: Submission[];
  runs: { id: string; kind: string; state: string; outcome: string | null; started_at: number; ended_at: number | null; agent_id: string; handle: string }[];
  thread: Post[];
};

export type RunEvent = { run_id: string; seq: number; ts: number; kind: string; item_id: string | null; status: string | null; data: Record<string, any> };

export type SysEvent = { id: number; ts: number; level: "info" | "ok" | "warn" | "error"; kind: string; message: string; agent_id?: string | null; sub_id?: string | null; run_id?: string | null; problem_id?: number | null; data?: any };

export type Activity = { run_id: string; agent_id: string; kind: string; status: string | null; label: string; ts: number };

export type Stats = {
  problems: number; excluded: number; byState: Record<string, number>; activeProblems: number; touched: number;
  posts: number; agentPosts: number; postsLastHour: number; submissions: number; reviews: number; reads: number;
};
