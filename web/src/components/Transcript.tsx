import { memo, useEffect, useMemo, useRef, useState } from "react";
import { get } from "../lib/api";
import { openLive } from "../lib/live";
import type { RunEvent } from "../lib/types";
import { clock, dur, compact } from "../lib/format";
import { Markdown } from "./ui";
import { toolGroup } from "../lib/colors";

const KINDS: { key: string; label: string; icon: string }[] = [
  { key: "reasoning", label: "Thinking", icon: "∴" },
  { key: "message", label: "Messages", icon: "❝" },
  { key: "tool", label: "Board tools", icon: "⌁" },
  { key: "command", label: "Shell", icon: "$" },
  { key: "search", label: "Web search", icon: "⌕" },
  { key: "file_change", label: "Files", icon: "▤" },
  { key: "system", label: "Supervisor", icon: "◇" },
  { key: "error", label: "Errors", icon: "!" },
];

/** Live, filterable transcript of one run: reasoning summaries, board tool calls, shell commands, searches. */
export function Transcript({ runId, live, onCounts }: { runId: string; live: boolean; onCounts?: (n: number) => void }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setEvents([]); setLoaded(false);
    void get<RunEvent[]>(`/runs/${runId}/events`).then((ev) => { if (alive) { setEvents(ev); setLoaded(true); } });
    if (!live) return () => { alive = false; };
    const close = openLive({
      run: runId,
      types: ["run.event"],
      onEvent: (_t, ev: RunEvent) => {
        if (ev.run_id !== runId) return;
        setEvents((cur) => {
          const i = ev.item_id ? cur.findIndex((x) => x.item_id === ev.item_id) : -1;
          if (i >= 0) { const n = cur.slice(); n[i] = { ...cur[i], ...ev, seq: cur[i].seq }; return n; }
          if (cur.some((x) => x.seq === ev.seq)) return cur;
          return [...cur, ev];
        });
      },
      onReset: () => { void get<RunEvent[]>(`/runs/${runId}/events`).then((ev) => alive && setEvents(ev)); },
    });
    return () => { alive = false; close(); };
  }, [runId, live]);

  useEffect(() => { onCounts?.(events.length); }, [events.length, onCounts]);
  // Follow inside the transcript box only; never scroll the page under the reader.
  useEffect(() => {
    const el = box.current;
    if (follow && live && loaded && el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [events.length, follow, live, loaded]);

  const shown = useMemo(() => events.filter((e) => {
    const k = e.kind === "failed" ? "error" : e.kind === "plan" ? "file_change" : e.kind;
    return !off.has(k) && e.kind !== "usage" && e.kind !== "other";
  }), [events, off]);
  const counts = useMemo(() => events.reduce<Record<string, number>>((m, e) => ((m[e.kind === "failed" ? "error" : e.kind] = (m[e.kind === "failed" ? "error" : e.kind] ?? 0) + 1), m), {}), [events]);

  return (
    <div>
      <div className="filters" style={{ padding: "10px 14px 0", marginBottom: 6 }}>
        {KINDS.map((k) => (
          <button key={k.key} className={`chip`} style={{ cursor: "pointer", opacity: off.has(k.key) ? 0.4 : 1 }} onClick={() => setOff((o) => { const n = new Set(o); n.has(k.key) ? n.delete(k.key) : n.add(k.key); return n; })}>
            <span className="mono" style={{ width: 10, textAlign: "center" }}>{k.icon}</span>{k.label}<span className="muted">{counts[k.key] ?? 0}</span>
          </button>
        ))}
        <span className="spacer" />
        {live && <label className="row tag" style={{ gap: 5, cursor: "pointer" }}><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />follow live</label>}
      </div>
      {!loaded && <div className="skeleton" style={{ height: 200, margin: 14 }} />}
      {loaded && shown.length === 0 && <div className="empty">No events yet{live ? ": the agent is starting up." : "."}</div>}
      <div className="tx tx-scroll" ref={box} onWheel={(e) => { if (e.deltaY < 0 && follow) setFollow(false); }}>
        {shown.map((e, i) => {
          const prev = shown[i - 1];
          const gap = prev ? e.ts - prev.ts : 0;
          return (
            <div key={`${e.seq}`}>
              {gap > 120_000 && <div className="tx-gap">· · · {dur(gap)} later · · ·</div>}
              <TxItem e={e} />
            </div>
          );
        })}
        {live && <div className="tx-gap"><span className="dot live" style={{ marginRight: 8 }} />streaming</div>}
      </div>
    </div>
  );
}

const TxItem = memo(function TxItem({ e }: { e: RunEvent }) {
  const [open, setOpen] = useState(false);
  const d = e.data;
  const k = KINDS.find((x) => x.key === (e.kind === "failed" ? "error" : e.kind));
  const icon = k?.icon ?? "·";
  let body: React.ReactNode = null;
  switch (e.kind) {
    case "reasoning":
      body = <div className="tx-reasoning"><Markdown text={String(d.text ?? "")} /></div>;
      break;
    case "message":
      body = <div><div className="tx-kind">agent message</div><Markdown text={String(d.text ?? "")} /></div>;
      break;
    case "command": {
      const out = String(d.output ?? "");
      body = (
        <div>
          <div className="row" style={{ gap: 6 }}>
            <span className="tx-kind">shell</span>
            {e.status === "in_progress" ? <span className="chip"><span className="dot live" />running</span> : <span className="chip" style={{ color: d.exit_code === 0 ? "var(--good-ink)" : "var(--critical)" }}>exit {String(d.exit_code ?? "?")}</span>}
          </div>
          <div className="tx-code">{String(d.command ?? "").replace(/^\/bin\/bash -lc /, "")}</div>
          {out && <div className="tx-code out" style={{ maxHeight: open ? 600 : 120, cursor: "pointer" }} onClick={() => setOpen(!open)}>{out}</div>}
        </div>
      );
      break;
    }
    case "tool": {
      const tool = String(d.tool ?? "");
      const args = (d.arguments ?? {}) as Record<string, any>;
      const g = toolGroup(tool);
      const summary = tool === "board_post" ? `${args.kind ?? ""}${args.problem_id ? ` → #${args.problem_id}` : args.channel ? ` → #${args.channel}` : ""}${args.title ? `: ${args.title}` : ""}`
        : tool === "board_read_thread" ? `#${args.problem_id}${args.since_id ? ` since #p${args.since_id}` : ""}`
        : tool === "board_status" ? `"${args.text}"`
        : tool === "board_submit" ? `${args.outcome}: ${String(args.summary ?? "").slice(0, 90)}`
        : tool === "board_review" ? `S${args.submission_id}: ${args.verdict}`
        : tool === "board_message" ? `→ @${args.to}`
        : tool === "board_search" ? `"${args.query}"`
        : Object.keys(args).length ? JSON.stringify(args).slice(0, 90) : "";
      body = (
        <div className="tx-tool">
          <div className="tx-tool-head" onClick={() => setOpen(!open)}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: g.color, flex: "none" }} />
            <b>{tool.replace(/^board_/, "board.")}</b>
            <span className="dim ellipsis grow" style={{ fontFamily: "var(--font-sans)" }}>{summary}</span>
            {e.status === "in_progress" ? <span className="dot live" /> : e.status === "failed" ? <span style={{ color: "var(--critical)" }}>failed</span> : null}
            <span className="muted">{open ? "▾" : "▸"}</span>
          </div>
          {open && (
            <div className="tx-tool-body">
              {tool === "board_post" || tool === "board_submit" || tool === "board_review" || tool === "board_message" ? (
                <Markdown text={String(args.body ?? args.writeup ?? args.summary ?? "")} />
              ) : (
                <div className="tx-code">{JSON.stringify(args, null, 1)}</div>
              )}
              {(d.result || d.error) && <div className="tx-code out" style={{ marginTop: 6 }}>{String(d.error ?? d.result)}</div>}
            </div>
          )}
        </div>
      );
      break;
    }
    case "search": {
      const act = String(d.action ?? "search");
      const target = act === "open_page" ? (d.url ?? d.query) : act === "find_in_page" ? `"${d.pattern ?? ""}" in ${d.url ?? ""}` : d.query;
      const label = act === "open_page" ? "opened page" : act === "find_in_page" ? "searched in page" : "web search";
      const isUrl = typeof target === "string" && /^https?:\/\//.test(target);
      body = <div><span className="tx-kind">{label}</span> {isUrl ? <a className="mono link" style={{ fontSize: 12.5 }} href={String(target)} target="_blank" rel="noopener noreferrer">{String(target)}</a> : <span className="mono" style={{ fontSize: 12.5 }}>{String(target || "…")}</span>}</div>;
      break;
    }
    case "file_change":
      body = <div><span className="tx-kind">files</span> <span className="mono" style={{ fontSize: 12 }}>{((d.changes ?? []) as any[]).map((c) => `${c.kind ?? ""} ${c.path ?? ""}`).join(", ")}</span></div>;
      break;
    case "plan":
      body = <div><span className="tx-kind">plan</span>{((d.items ?? []) as any[]).map((it, i) => <div key={i} style={{ fontSize: 12.5 }}>{it.completed ? "☑" : "☐"} {it.text}</div>)}</div>;
      break;
    case "system":
      body = <div>{String(d.message ?? "")}{d.pid ? ` · pid ${d.pid}` : ""}</div>;
      break;
    case "error":
    case "failed":
      body = <div>{String(d.message ?? "")}</div>;
      break;
    default:
      body = <div className="mono" style={{ fontSize: 11 }}>{JSON.stringify(d).slice(0, 300)}</div>;
  }
  return (
    <div className={`tx-item ${e.kind === "system" ? "system" : ""} ${e.kind === "error" || e.kind === "failed" ? "error" : ""}`}>
      <div className="tx-time">{clock(e.ts, true)}</div>
      <div className="tx-icon mono">{icon}</div>
      <div className="tx-body">{body}</div>
    </div>
  );
});

export function TokenLine({ t }: { t: { in: number; out: number; reasoning: number; cached: number } }) {
  return <span className="mono tag">{compact(t.in)} in ({compact(t.cached)} cached) · {compact(t.out)} out · {compact(t.reasoning)} reasoning</span>;
}
