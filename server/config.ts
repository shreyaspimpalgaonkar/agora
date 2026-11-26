import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.AGORA_DATA ?? path.join(ROOT, ".data");
export const SUBS_DIR = path.join(DATA_DIR, "subs");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const PORT = Number(process.env.PORT ?? 4410);
export const HOST = process.env.HOST ?? "127.0.0.1";
/** Where the board MCP server (a child of each codex process) reaches the hub. */
export const HUB_URL = process.env.AGORA_HUB_URL ?? `http://127.0.0.1:${PORT}`;
/** Absolute path of the codex binary, resolved once (the launcher on PATH may depend on HOME). */
export const CODEX_BIN = process.env.CODEX_BIN ?? (() => {
  try {
    return fs.realpathSync(execSync("command -v codex", { encoding: "utf8" }).trim());
  } catch {
    return "codex";
  }
})();
export const MCP_SCRIPT = path.join(ROOT, "server", "mcp", "board-mcp.mjs");
export const AGENT_TOOLS_BIN = path.join(DATA_DIR, "agent-env", "bin");

export const ALLOWED_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

for (const d of [DATA_DIR, SUBS_DIR, RUNS_DIR]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); } catch { /* best effort */ }

/** Access keys live in .data/keys.json so they survive restarts. */
function loadKeys(): { admin: string; viewer: string } {
  const f = path.join(DATA_DIR, "keys.json");
  if (fs.existsSync(f)) {
    try { fs.chmodSync(f, 0o600); } catch { /* best effort */ }
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  const keys = {
    admin: process.env.AGORA_ADMIN_KEY ?? crypto.randomBytes(24).toString("base64url"),
    viewer: process.env.AGORA_VIEW_KEY ?? crypto.randomBytes(18).toString("base64url"),
  };
  fs.writeFileSync(f, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}
export const KEYS = loadKeys();

/** Defaults for a newly attached subscription. All of them can be changed per subscription in the UI. */
export const DEFAULTS = {
  model: process.env.AGORA_MODEL ?? "gpt-6-astra",
  effort: process.env.AGORA_EFFORT ?? "xhigh",
  agentsPerSub: Number(process.env.AGORA_AGENTS_PER_SUB ?? 2),
  /** Stop starting new runs on a subscription once its usage window passes this percent. */
  reservePct: 80,
  /** Soft budget told to the agent, and the hard wall-clock limit enforced by the supervisor. */
  runBudgetMin: 40,
  runHardLimitMin: 110,
  /** Kill and resume a run whose event stream has been silent this long. */
  stallMin: 30,
  /** A lease on a problem lapses if the agent shows no activity for this long. */
  leaseMin: 35,
  maxResumes: 3,
  probeModel: "gpt-6-luna",
};

export const now = () => Date.now();
