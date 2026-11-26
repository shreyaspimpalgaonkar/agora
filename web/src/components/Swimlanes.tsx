import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as d3 from "d3";
import { useStore, serverNow } from "../lib/store";
import { agentColor, kindColor, KIND_FAMILIES, kindLabel } from "../lib/colors";
import { clock, dur } from "../lib/format";
import { Glyph } from "./Glyph";
import { Tooltip, useMeasure, type Tip } from "./ui";

export type TimelineData = {
  agents: { id: string; handle: string; sub_label?: string; created_at: number; status: string; first_seen_board_at: number | null; first_post_at: number | null }[];
  runs: { id: string; agent_id: string; kind: string; role: string | null; problem_id: number; submission_id: number | null; state: string; outcome: string | null; started_at: number; ended_at: number | null; resumes: number; domain: string; title: string }[];
  posts: { id: number; ts: number; agent_id: string; kind: string; problem_id: number | null; channel: string; parent_id: number | null; to_agent_id: string | null; mentions: string[] }[];
  reads: { ts: number; agent_id: string; target: string }[];
  incidents: { id: number; ts: number; level: string; kind: string; agent_id: string; run_id: string; message: string }[];
  now: number;
};

const ROW = 46;
const GUTTER = 150;

/**
 * One row per agent across time (after METR's participation timeline). Bars are sessions on a
 * problem, ticks above are posts colored by kind, dots below are board reads, and curves join a
 * post to the agent it mentions or answers. Crashes, resumes and re-attaches are marked inline.
 */
export function Swimlanes({ data, windowMs, compact = false, highlight }: { data: TimelineData | null; windowMs: number | null; compact?: boolean; highlight?: string }) {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const order = useStore((s) => s.agentOrder);
  const [tip, setTip] = useState<Tip>(null);
  const [focus, setFocus] = useState<string | null>(highlight ?? null);
  const nav = useNavigate();

  const model = useMemo(() => {
    if (!data) return null;
    const now = serverNow();
    const agents = data.agents.filter((a) => a.status !== "retired" || data.runs.some((r) => r.agent_id === a.id));
    const t0raw = Math.min(...agents.map((a) => a.created_at), now - 60_000);
    const t0 = windowMs ? Math.max(t0raw, now - windowMs) : t0raw;
    const rowOf = new Map(agents.map((a, i) => [a.id, i]));
    const postAuthor = new Map(data.posts.map((p) => [p.id, p.agent_id]));
    const handleToId = new Map(agents.map((a) => [a.handle, a.id]));
    const links: { from: string; to: string; ts: number; kind: string; post: number }[] = [];
    for (const p of data.posts) {
      if (p.ts < t0) continue;
      const targets = new Set<string>();
      for (const m of p.mentions) if (m !== p.agent_id) targets.add(m);
      if (p.to_agent_id) targets.add(p.to_agent_id);
      if (p.parent_id) { const a = postAuthor.get(p.parent_id); if (a && a !== p.agent_id) targets.add(a); }
      for (const t of targets) if (rowOf.has(t) && rowOf.has(p.agent_id)) links.push({ from: p.agent_id, to: t, ts: p.ts, kind: p.kind, post: p.id });
    }
    return { now, t0, agents, rowOf, links, handleToId };
  }, [data, windowMs]);

  // Phones scroll the lanes sideways rather than squeezing an hour into 200px.
  const width = Math.max(680, size.width);
  if (!data || !model) return <div ref={ref} className="skeleton" style={{ height: compact ? 160 : 260 }} />;
  const { now, t0, agents, rowOf, links } = model;
  const x = d3.scaleTime().domain([t0, now + (now - t0) * 0.015]).range([GUTTER, width - 14]);
  const rowH = compact ? 36 : ROW;
  const height = agents.length * rowH + 30;
  const ticks = x.ticks(Math.max(2, Math.floor((width - GUTTER) / 110)));
  const yMid = (i: number) => i * rowH + rowH / 2;
  const isDim = (id: string) => focus !== null && focus !== id;

  return (
    <div ref={ref} className="chart" style={{ overflowX: "auto", overflowY: "hidden" }}>
      {!compact && (
        <div className="legend">
          <span className="legend-item"><span className="key" style={{ background: "var(--ink-3)", height: 10, width: 18, borderRadius: 3, opacity: 0.4 }} />Session on a problem</span>
          <span className="legend-item"><span className="key" style={{ height: 10, width: 18, borderRadius: 3, background: "repeating-linear-gradient(45deg, var(--c4) 0 2px, transparent 2px 5px)" }} />Review session</span>
          {KIND_FAMILIES.filter((f) => f.key !== "notes").map((f) => <span key={f.key} className="legend-item"><span className="key" style={{ background: f.color, width: 3, height: 11 }} />{f.label}</span>)}
          <span className="legend-item"><span className="key" style={{ background: "var(--ink-3)", width: 4, height: 4, borderRadius: 4 }} />Board read</span>
          <span className="legend-item"><span className="key" style={{ background: "var(--signal)", height: 2 }} />Mention / reply</span>
          <span className="legend-item">✕ crash · ↻ resumed · ◆ re-attached</span>
        </div>
      )}
      {agents.length === 0 ? <div className="empty">No agents yet. Attach a Codex subscription to start the swarm.</div> : (
        <svg width={width} height={height} onMouseLeave={() => setTip(null)}>
          <g className="axis">
            {ticks.map((t) => (
              <g key={+t} transform={`translate(${x(t)},0)`}>
                <line y1={0} y2={height - 24} stroke="var(--line-2)" />
                <text y={height - 8} textAnchor="middle">{clock(+t)}</text>
              </g>
            ))}
          </g>
          {agents.map((a, i) => {
            const y = i * rowH;
            const color = agentColor(a.id, order);
            const dim = isDim(a.id);
            const runs = data.runs.filter((r) => r.agent_id === a.id && (r.ended_at ?? now) >= t0);
            const posts = data.posts.filter((p) => p.agent_id === a.id && p.ts >= t0);
            const reads = data.reads.filter((r) => r.agent_id === a.id && r.ts >= t0);
            const inc = data.incidents.filter((e) => e.agent_id === a.id && e.ts >= t0);
            const barY = y + rowH / 2 - (compact ? 6 : 7), barH = compact ? 12 : 14;
            return (
              <g key={a.id} opacity={dim ? 0.28 : 1} style={{ transition: "opacity .2s" }}
                onMouseEnter={() => setFocus(a.id)} onMouseLeave={() => setFocus(highlight ?? null)}>
                <rect x={0} y={y} width={width} height={rowH} fill="transparent" />
                <line x1={Math.max(GUTTER, x(a.created_at))} x2={x(now)} y1={yMid(i)} y2={yMid(i)} stroke="var(--line)" />
                <foreignObject x={0} y={y + rowH / 2 - 11} width={GUTTER - 10} height={22}>
                  <div className="row" style={{ gap: 6, cursor: "pointer", height: 22 }} onClick={() => nav(`/agents/${a.id}`)}>
                    <Glyph id={a.id} size={20} live={a.status === "running"} />
                    <span className="mono" style={{ fontSize: 11.5, fontWeight: 600 }}>{a.handle}</span>
                  </div>
                </foreignObject>
                {runs.map((r) => {
                  const x0 = Math.max(GUTTER, x(r.started_at)), x1 = Math.max(x0 + 2, x(r.ended_at ?? now));
                  const review = r.kind === "review";
                  const live = !r.ended_at;
                  const w = x1 - x0;
                  return (
                    <g key={r.id} style={{ cursor: "pointer" }} onClick={() => nav(`/agents/${a.id}?run=${r.id}`)}
                      onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, content: (
                        <div>
                          <div className="tt-title">{a.handle} · {review ? `review of S${r.submission_id}` : r.role === "partner" ? "partner" : "lead"} on #{r.problem_id}</div>
                          <div className="dim" style={{ fontSize: 11.5, marginBottom: 4 }}>{r.title}</div>
                          <div className="tt-row">Duration<span className="v">{dur((r.ended_at ?? now) - r.started_at)}</span></div>
                          <div className="tt-row">State<span className="v">{r.state}{r.outcome ? ` → ${r.outcome}` : ""}</span></div>
                          {r.resumes > 0 && <div className="tt-row">Restarts survived<span className="v">{r.resumes}</span></div>}
                          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Click to open the transcript</div>
                        </div>) })}
                      onMouseLeave={() => setTip(null)}>
                      <rect x={x0} y={barY} width={w} height={barH} rx={4}
                        fill={review ? "url(#hatch)" : color} fillOpacity={review ? 1 : 0.2} stroke={color} strokeOpacity={0.9} strokeWidth={1} />
                      {live && <rect x={x1 - 3} y={barY} width={3} height={barH} rx={1.5} fill="var(--signal)"><animate attributeName="opacity" values="1;0.2;1" dur="1.4s" repeatCount="indefinite" /></rect>}
                      {w > 70 && !compact && <text x={x0 + 7} y={barY + barH / 2 + 3.5} fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--ink)" style={{ pointerEvents: "none" }}>
                        #{r.problem_id} {r.title.length > w / 7 ? r.title.slice(0, Math.max(0, Math.floor(w / 7) - 6)) + "…" : r.title}
                      </text>}
                      {r.outcome && <circle cx={x1} cy={barY + barH / 2} r={4.5} fill={r.outcome.startsWith("review:accept") || r.outcome === "solved" || r.outcome === "disproved" ? "var(--c6)" : r.outcome === "partial" ? "var(--c3)" : r.outcome.startsWith("review") ? "var(--c4)" : "var(--ink-3)"} stroke="var(--panel)" strokeWidth={2} />}
                    </g>
                  );
                })}
                {posts.map((p) => (
                  <line key={p.id} x1={x(p.ts)} x2={x(p.ts)} y1={barY - 9} y2={barY - 1} stroke={kindColor(p.kind)} strokeWidth={2.5} strokeLinecap="round"
                    style={{ cursor: "pointer" }} onClick={() => nav(`/board?post=${p.id}`)}
                    onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, content: <div><div className="tt-title">#p{p.id} · {kindLabel(p.kind)}</div><div className="dim">{a.handle}{p.problem_id ? ` on #${p.problem_id}` : ""} · {clock(p.ts, true)}</div></div> })}
                    onMouseLeave={() => setTip(null)} />
                ))}
                {!compact && reads.map((r, k) => <circle key={k} cx={x(r.ts)} cy={barY + barH + 5} r={1.6} fill="var(--ink-3)" opacity={0.7} />)}
                {inc.map((e) => {
                  const sym = e.kind === "run.crashed" || e.kind === "chaos.kill" ? "✕" : e.kind === "run.resumed" ? "↻" : e.kind === "run.reattached" ? "◆" : e.kind === "lease.expired" ? "⌛" : "!";
                  const col = sym === "✕" ? "var(--critical)" : sym === "↻" ? "var(--signal-ink)" : sym === "◆" ? "var(--c1)" : "var(--warning-ink)";
                  return (
                    <text key={e.id} x={x(e.ts)} y={barY + barH + (compact ? 12 : 16)} textAnchor="middle" fontSize={11} fill={col} style={{ cursor: "default" }}
                      onMouseMove={(ev) => setTip({ x: ev.clientX, y: ev.clientY, content: <div><div className="tt-title">{e.kind}</div><div className="dim" style={{ maxWidth: 280 }}>{e.message}</div><div className="muted mono" style={{ fontSize: 11 }}>{clock(e.ts, true)} UTC</div></div> })}
                      onMouseLeave={() => setTip(null)}>{sym}</text>
                  );
                })}
              </g>
            );
          })}
          {links.map((l, k) => {
            const i = rowOf.get(l.from)!, j = rowOf.get(l.to)!;
            const lx = x(l.ts);
            const y0 = yMid(i) - (compact ? 10 : 12), y1 = yMid(j) - (compact ? 10 : 12);
            const show = focus === null || focus === l.from || focus === l.to;
            return <path key={k} d={`M${lx},${y0} C${lx + 26},${y0} ${lx + 26},${y1} ${lx + 4},${y1}`} fill="none" stroke="var(--signal)" strokeWidth={1.5} opacity={show ? 0.85 : 0.08} markerEnd="url(#arrow)" />;
          })}
          <defs>
            <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill="color-mix(in srgb, var(--c4) 18%, transparent)" />
              <line x1="0" y1="0" x2="0" y2="5" stroke="var(--c4)" strokeWidth="2" />
            </pattern>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--signal)" />
            </marker>
          </defs>
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}
