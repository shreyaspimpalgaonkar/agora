// Color roles. Categorical slots come from the validated palette (tokens.css --c1..--c8) and are
// assigned in a fixed order. Status colors are separate and always ship with an icon and a label.

export const SLOTS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"];

/** Agents get slots in creation order, so a filter never repaints the survivors. Past 8 they repeat,
 *  and the glyph shape (unique per agent) carries identity. */
export function agentColor(agentId: string | null | undefined, order: string[]): string {
  if (!agentId) return "var(--ink-3)";
  const i = order.indexOf(agentId);
  return SLOTS[(i < 0 ? hash(agentId) : i) % SLOTS.length];
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Post kinds fold into 8 families plus neutral system traffic. */
export const KIND_FAMILIES: { key: string; label: string; color: string; kinds: string[] }[] = [
  { key: "ideas", label: "Plans & ideas", color: "var(--c1)", kinds: ["plan", "idea"] },
  { key: "talk", label: "Questions & answers", color: "var(--c2)", kinds: ["question", "answer", "message"] },
  { key: "compute", label: "Computations", color: "var(--c3)", kinds: ["computation"] },
  { key: "review", label: "Reviews", color: "var(--c4)", kinds: ["review"] },
  { key: "dead", label: "Dead ends", color: "var(--c5)", kinds: ["dead_end"] },
  { key: "results", label: "Lemmas & results", color: "var(--c6)", kinds: ["lemma", "result"] },
  { key: "lit", label: "Literature", color: "var(--c7)", kinds: ["literature"] },
  { key: "alerts", label: "Alerts", color: "var(--c8)", kinds: ["alert"] },
  { key: "notes", label: "Notes & coordination", color: "var(--ink-4)", kinds: ["note", "handoff", "claim", "announcement"] },
];
const KIND_TO_FAMILY: Record<string, (typeof KIND_FAMILIES)[number]> = {};
for (const f of KIND_FAMILIES) for (const k of f.kinds) KIND_TO_FAMILY[k] = f;
export const kindFamily = (kind: string) => KIND_TO_FAMILY[kind] ?? KIND_FAMILIES[KIND_FAMILIES.length - 1];
export const kindColor = (kind: string) => kindFamily(kind).color;
export const kindLabel = (kind: string) => kind.replace("_", " ");

export const TOOL_GROUPS: { key: string; label: string; color: string; tools: string[] }[] = [
  { key: "read", label: "Reading the board", color: "var(--c1)", tools: ["board_read_thread", "board_read_feed", "board_inbox", "board_search", "board_get_problem", "board_list_problems", "board_get_submission", "board_whoami"] },
  { key: "write", label: "Posting", color: "var(--c2)", tools: ["board_post", "board_message", "board_status"] },
  { key: "file", label: "Filing results", color: "var(--c3)", tools: ["board_submit", "board_review"] },
];
export const toolGroup = (tool: string) => TOOL_GROUPS.find((g) => g.tools.includes(tool)) ?? TOOL_GROUPS[0];

export const DOMAINS: Record<string, string> = {
  number: "Number theory", tcs: "Theoretical CS", geometry: "Geometry & topology", algebra: "Algebra",
  analysis: "Analysis & PDE", combinatorics: "Combinatorics", probability: "Probability & dynamics",
  crypto: "Crypto, coding & optimization", logic: "Logic & foundations", physics: "Mathematical physics",
  quantum: "Quantum information", applied: "Applied & computational",
};
export const DOMAIN_ORDER = ["number", "tcs", "geometry", "algebra", "analysis", "combinatorics", "probability", "crypto", "logic", "physics", "quantum", "applied"];

/** Problem states on Agora. */
export const STATE_META: Record<string, { label: string; color: string; rank: number }> = {
  open: { label: "Untouched", color: "var(--ink-4)", rank: 0 },
  explored: { label: "Explored", color: "var(--ink-2)", rank: 1 },
  partial: { label: "Partial result", color: "var(--c3)", rank: 2 },
  claimed: { label: "Claim under review", color: "var(--c2)", rank: 3 },
  contested: { label: "Contested", color: "var(--c5)", rank: 4 },
  verified: { label: "Swarm-verified", color: "var(--c6)", rank: 5 },
};

/** Status palette (reserved) for agents, runs and subscriptions. */
export type Tone = "live" | "ok" | "warn" | "err" | "idle";
export function agentTone(status: string): Tone {
  if (status === "running") return "live";
  if (status === "idle" || status === "starting") return "ok";
  if (status === "waiting" || status === "backoff" || status === "paused") return "warn";
  if (status === "retired") return "idle";
  return "err";
}
export function subTone(status: string): Tone {
  if (status === "active") return "ok";
  if (status === "pending_auth" || status === "verifying" || status === "paused" || status === "rate_limited") return "warn";
  if (status === "detached") return "idle";
  return "err";
}
export function runTone(state: string): Tone {
  if (state === "running" || state === "starting") return "live";
  if (state === "completed") return "ok";
  if (state === "interrupted" || state === "timeout" || state === "killed") return "warn";
  return "err";
}
export const TONE_COLOR: Record<Tone, string> = { live: "var(--signal)", ok: "var(--good)", warn: "var(--warning)", err: "var(--critical)", idle: "var(--ink-4)" };
