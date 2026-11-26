import fs from "node:fs";
import { redact, redactDeep } from "../security.js";

/** Reads whole lines appended to a file since the last call. Safe against partial writes. */
export class LineTailer {
  private buf = "";
  constructor(public file: string, public offset = 0) {}
  read(): string[] {
    let fd: number;
    try { fd = fs.openSync(this.file, "r"); } catch { return []; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) { this.offset = 0; this.buf = ""; } // truncated or replaced
      if (size === this.offset) return [];
      const len = Math.min(size - this.offset, 8 * 1024 * 1024);
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, this.offset);
      this.offset += len;
      this.buf += chunk.toString("utf8");
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      return lines.filter((l) => l.trim().length > 0);
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Offset of the last complete line, for persisting a resume point. */
  get committed() { return this.offset - Buffer.byteLength(this.buf); }
}

export type NormEvent = {
  kind: string;          // message | reasoning | command | tool | search | file_change | plan | error | usage | failed | thread | turn
  item_id?: string;
  status?: string;       // in_progress | completed | failed
  data: Record<string, unknown>;
};

const clip = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s : s == null ? "" : JSON.stringify(s);
  return t.length > n ? t.slice(0, n) + `\n… [${t.length - n} more chars]` : t;
};

function toolResultText(result: any): string {
  if (!result) return "";
  const parts = Array.isArray(result.content) ? result.content : [];
  return parts.map((p: any) => (p?.type === "text" ? p.text : JSON.stringify(p))).join("\n");
}

/** Map one `codex exec --json` line to the event shape the board stores and streams. */
export function normalize(line: string): NormEvent | null {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return { kind: "error", data: { message: `unparseable output: ${redact(clip(line, 300))}` } }; }
  switch (ev.type) {
    case "thread.started": return { kind: "thread", data: { thread_id: ev.thread_id } };
    case "turn.started": return { kind: "turn", data: { phase: "started" } };
    case "turn.completed": return { kind: "usage", data: { usage: ev.usage ?? {} } };
    case "turn.failed": return { kind: "failed", data: { message: redact(String(ev.error?.message ?? "turn failed")) } };
    case "error": return { kind: "error", data: { message: redact(String(ev.message ?? "error")) } };
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const it = ev.item ?? {};
      const status = ev.type === "item.completed" ? (it.status === "failed" ? "failed" : "completed") : "in_progress";
      switch (it.type) {
        case "agent_message": return { kind: "message", item_id: it.id, status, data: { text: redact(String(it.text ?? "")) } };
        case "reasoning": return { kind: "reasoning", item_id: it.id, status, data: { text: redact(String(it.text ?? "")) } };
        case "command_execution":
          return {
            kind: "command", item_id: it.id, status: it.status === "failed" ? "failed" : status,
            data: { command: redact(clip(it.command, 4000)), output: redact(clip(it.aggregated_output, 16000)), exit_code: it.exit_code ?? null },
          };
        case "mcp_tool_call":
          return {
            kind: "tool", item_id: it.id, status: it.error ? "failed" : status,
            data: {
              server: it.server,
              tool: it.tool,
              arguments: redactDeep(it.arguments ?? {}),
              result: redact(clip(toolResultText(it.result), 12000)),
              error: it.error?.message ? redact(String(it.error.message)) : null,
            },
          };
        case "web_search": {
          const a = it.action ?? {};
          return { kind: "search", item_id: it.id, status, data: { query: redact(String(it.query || a.query || "")), action: a.type ?? "search", url: a.url ?? null, pattern: a.pattern ?? null } };
        }
        case "file_change": return { kind: "file_change", item_id: it.id, status, data: { changes: redactDeep(it.changes ?? []) } };
        case "todo_list": return { kind: "plan", item_id: it.id, status, data: { items: redactDeep(it.items ?? []) } };
        case "error": return { kind: "error", item_id: it.id, status, data: { message: redact(String(it.message ?? "")) } };
        default: return { kind: "other", item_id: it.id, status, data: { type: it.type, raw: redact(clip(it, 2000)) } };
      }
    }
    default:
      return { kind: "other", data: { type: ev.type, raw: redact(clip(ev, 2000)) } };
  }
}

/** Codex errors we know how to react to. */
export function classifyError(text: string): "usage_limit" | "auth" | "transient" | "fatal" {
  const t = text.toLowerCase();
  if (/usage limit|rate limit|too many requests|\b429\b|quota|limit reached|try again (at|in)/.test(t)) return "usage_limit";
  if (/could not be refreshed|log out and sign in|unauthorized|\b401\b|refresh token|not logged in|sign in again|authentication/.test(t)) return "auth";
  if (/stream disconnected|timed out|timeout|connection|network|reset by peer|\b50[0234]\b|internal server error|overloaded|temporarily|websocket|killed|signal/.test(t)) return "transient";
  return "fatal";
}
