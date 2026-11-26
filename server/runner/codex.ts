import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { AGENT_TOOLS_BIN, ALLOWED_EFFORTS, CODEX_BIN, DATA_DIR, HUB_URL, MCP_SCRIPT, MODEL_RE } from "../config.js";

export const AGENT_HOME = path.join(DATA_DIR, "agent-home");
fs.mkdirSync(AGENT_HOME, { recursive: true, mode: 0o700 });
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
// Login shells reset PATH from /etc/profile, so the agents' Python tools are added back here.
fs.writeFileSync(path.join(AGENT_HOME, ".bash_profile"), `export PATH=${shQuote(AGENT_TOOLS_BIN)}:"$PATH"\nexport PYTHONDONTWRITEBYTECODE=1\n`, { mode: 0o600 });
fs.writeFileSync(path.join(AGENT_HOME, ".bashrc"), `export PATH=${shQuote(AGENT_TOOLS_BIN)}:"$PATH"\n`, { mode: 0o600 });

/**
 * Environment for every codex process. HOME points at an empty agent home so the agents do not
 * load the host user's dotfiles, skills or other Codex logins.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  return {
    PATH: `${AGENT_TOOLS_BIN}:${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: AGENT_HOME,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
  };
}

/** Features a math agent does not need. Turning off `apps` keeps the volunteer's ChatGPT connectors out of reach. */
export const FEATURE_FLAGS = [
  "apps", "browser_use", "browser_use_external", "computer_use", "in_app_browser", "image_generation",
  "plugins", "remote_plugin", "multi_agent", "tool_suggest", "goals",
].flatMap((f) => ["--disable", f]);

const tomlStr = (s: string) => JSON.stringify(s);

export function execArgs(o: { workDir: string; model: string; effort: string; token: string; resumeThread?: string | null }) {
  if (!MODEL_RE.test(o.model)) throw new Error("invalid model name");
  if (!(ALLOWED_EFFORTS as readonly string[]).includes(o.effort)) throw new Error("invalid reasoning effort");
  const args = [
    "exec", "--json", "--skip-git-repo-check", "-C", o.workDir, "-s", "workspace-write",
    "-m", o.model,
    "-c", `model_reasoning_effort=${tomlStr(o.effort)}`,
    "-c", 'model_reasoning_summary="detailed"',
    "-c", 'web_search="live"',
    "-c", `mcp_servers.agora.command=${tomlStr(process.execPath)}`,
    "-c", `mcp_servers.agora.args=[${tomlStr(MCP_SCRIPT)}]`,
    "-c", `mcp_servers.agora.env={AGORA_URL=${tomlStr(HUB_URL)}, AGORA_RUN_TOKEN=${tomlStr(o.token)}}`,
    "-c", 'mcp_servers.agora.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.agora.startup_timeout_sec=60",
    "-c", "mcp_servers.agora.tool_timeout_sec=300",
    ...FEATURE_FLAGS,
  ];
  if (o.resumeThread) args.push("resume", o.resumeThread, "-");
  else args.push("-");
  return args;
}

/**
 * Start codex detached, in its own process group, with stdin from the prompt file and stdout
 * going straight to a file. Because nothing is piped through the hub, a hub restart does not
 * touch running agents; the new hub re-attaches by reading the same files.
 */
export function spawnCodex(o: { args: string[]; cwd: string; home: string; promptFile: string; outFile: string; errFile: string }): ChildProcess {
  const inFd = fs.openSync(o.promptFile, "r");
  const outFd = fs.openSync(o.outFile, "a", 0o600);
  const errFd = fs.openSync(o.errFile, "a", 0o600);
  try {
    const child = spawn(CODEX_BIN, o.args, {
      cwd: o.cwd, env: { ...agentEnv(), CODEX_HOME: o.home }, detached: true, stdio: [inFd, outFd, errFd],
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(inFd); fs.closeSync(outFd); fs.closeSync(errFd);
  }
}

/** True if `pid` is alive and is the codex process for this run (guards against PID reuse). */
export function isRunAlive(pid: number | null | undefined, marker: string): boolean {
  if (!Number.isInteger(pid) || !pid || pid <= 1) return false;
  if (process.platform === "linux") {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmd.includes(marker)) return false;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return !/\) Z /.test(stat); // zombie means it already exited
    } catch {
      return false;
    }
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "stat=,command="], { encoding: "utf8", timeout: 2000 }).trim();
    if (!out) return false;
    const spaceIdx = out.search(/\s/);
    const stat = spaceIdx === -1 ? out : out.slice(0, spaceIdx);
    const cmd = spaceIdx === -1 ? "" : out.slice(spaceIdx).trim();
    if (stat.startsWith("Z")) return false;
    return cmd.includes(marker);
  } catch {
    return false;
  }
}

export function killGroup(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  // Never allow pid <= 1, since process.kill(-1) signals all user processes and kill(0) signals self group.
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, signal); return true; } catch { /* not a group leader */ }
  try { process.kill(pid, signal); return true; } catch { return false; }
}
