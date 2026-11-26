import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as d3 from "d3";
import { useStore } from "../lib/store";
import { agentColor } from "../lib/colors";
import { Tooltip, useMeasure, type Tip } from "./ui";

export type GraphData = {
  nodes: { id: string; handle: string; sub_id: string; posts: number }[];
  edges: { source: string; target: string; type: string; weight: number; first: number; last: number }[];
  work?: { agent_id: string; problem_id: number; title: string; domain: string; n: number; last: number }[];
};

export const EDGE_TYPES: { key: string; label: string; color: string; note: string }[] = [
  { key: "reply", label: "Replied to", color: "var(--c2)", note: "A answered one of B's posts" },
  { key: "mention", label: "Mentioned", color: "var(--c1)", note: "A @-mentioned B" },
  { key: "message", label: "Direct message", color: "var(--c7)", note: "A sent B a direct message" },
  { key: "review", label: "Reviewed", color: "var(--c4)", note: "A reviewed B's submission" },
  { key: "read", label: "Read the posts of", color: "var(--ink-3)", note: "information flow: B read posts written by A" },
  { key: "cothread", label: "Same thread", color: "var(--ink-4)", note: "both posted in one problem thread" },
];

type N = d3.SimulationNodeDatum & { id: string; label: string; kind: "agent" | "problem"; size: number; sub_id?: string; title?: string };
type E = { source: N; target: N; type: string; weight: number };

export function NetworkGraph({ data, height = 420, since = 0 }: { data: GraphData | null; height?: number; since?: number }) {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const order = useStore((s) => s.agentOrder);
  const subs = useStore((s) => s.subs);
  const [on, setOn] = useState<Set<string>>(new Set(["reply", "mention", "message", "review", "read", "work"]));
  const [tip, setTip] = useState<Tip>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const nodesRef = useRef<Map<string, N>>(new Map());
  const nav = useNavigate();
  const width = Math.max(300, size.width);

  const graph = useMemo(() => {
    if (!data) return null;
    const keep = (n: N) => {
      const prev = nodesRef.current.get(n.id);
      return prev ? Object.assign(prev, n) : { ...n, x: width / 2 + (Math.random() - 0.5) * 120, y: height / 2 + (Math.random() - 0.5) * 120 };
    };
    const nodes: N[] = data.nodes.map((n) => keep({ id: n.id, label: n.handle, kind: "agent", size: n.posts, sub_id: n.sub_id }));
    const work = (data.work ?? []).filter((w) => w.last >= since);
    if (on.has("work")) {
      const probs = new Map<number, { title: string; n: number }>();
      for (const w of work) { const p = probs.get(w.problem_id) ?? { title: w.title, n: 0 }; p.n += w.n; probs.set(w.problem_id, p); }
      for (const [pid, p] of probs) nodes.push(keep({ id: `p:${pid}`, label: `#${pid}`, kind: "problem", size: p.n, title: p.title }));
    }
    nodesRef.current = new Map(nodes.map((n) => [n.id, n]));
    const edges: E[] = data.edges
      .filter((e) => on.has(e.type) && e.last >= since)
      .map((e) => ({ source: nodesRef.current.get(e.source)!, target: nodesRef.current.get(e.target)!, type: e.type, weight: e.weight }))
      .filter((e) => e.source && e.target);
    if (on.has("work")) for (const w of work) {
      const a = nodesRef.current.get(w.agent_id), p = nodesRef.current.get(`p:${w.problem_id}`);
      if (a && p) edges.push({ source: a, target: p, type: "work", weight: w.n });
    }
    return { nodes, edges };
  }, [data, on, since, width, height]);

  useEffect(() => {
    if (!graph) return;
    const s = d3.forceSimulation<N>(graph.nodes)
      .force("charge", d3.forceManyBody<N>().strength((n) => (n.kind === "agent" ? -600 : -260)))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide<N>().radius((n) => r(n) + 24))
      .force("link", d3.forceLink<N, E>(graph.edges.filter((e) => e.type !== "cothread")).distance((e) => (e.type === "work" ? 90 : 170)).strength((e) => (e.type === "work" ? 0.25 : 0.06)))
      .force("x", d3.forceX(width / 2).strength(0.05))
      .force("y", d3.forceY(height / 2).strength(0.09))
      .alpha(0.7)
      .on("tick", () => {
        for (const n of graph.nodes) { n.x = Math.max(44, Math.min(width - 44, n.x ?? 0)); n.y = Math.max(30, Math.min(height - 40, n.y ?? 0)); }
        setTick((t) => t + 1);
      });
    return () => { s.stop(); };
  }, [graph, width, height]);

  function r(n: N) { return n.kind === "agent" ? 11 + Math.sqrt(n.size) * 3 : 6 + Math.sqrt(n.size) * 1.6; }
  const maxW = Math.max(1, ...(graph?.edges.filter((e) => e.type !== "work").map((e) => e.weight) ?? [1]));
  const subOrder = Object.keys(subs);
  const linked = (a: string, b: string) => graph?.edges.some((e) => (e.source.id === a && e.target.id === b) || (e.target.id === a && e.source.id === b));

  return (
    <div ref={ref} className="chart">
      <div className="legend">
        {EDGE_TYPES.map((t) => (
          <span key={t.key} title={t.note} className={`legend-item toggle ${on.has(t.key) ? "" : "off"}`} onClick={() => setOn((o) => { const n = new Set(o); n.has(t.key) ? n.delete(t.key) : n.add(t.key); return n; })}>
            <span className="key" style={{ background: t.color }} />{t.label}
          </span>
        ))}
        <span title="Problems an agent posted about" className={`legend-item toggle ${on.has("work") ? "" : "off"}`} onClick={() => setOn((o) => { const n = new Set(o); n.has("work") ? n.delete("work") : n.add("work"); return n; })}>
          <span className="key sq" style={{ background: "var(--ink)", borderRadius: 2 }} />Problems worked on
        </span>
      </div>
      {!graph || graph.nodes.length === 0 ? <div className="empty">No agents yet.</div> : (
        <svg width={width} height={height} onMouseLeave={() => { setTip(null); setHover(null); }}>
          <defs>
            {EDGE_TYPES.map((t) => (
              <marker key={t.key} id={`ah-${t.key}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={t.color} />
              </marker>
            ))}
          </defs>
          {graph.edges.map((e, i) => {
            const sx = e.source.x!, sy = e.source.y!, tx = e.target.x!, ty = e.target.y!;
            const dim = hover && e.source.id !== hover && e.target.id !== hover;
            if (e.type === "work") {
              return <line key={i} x1={sx} y1={sy} x2={tx} y2={ty} stroke="var(--line)" strokeWidth={1 + Math.min(3, Math.log1p(e.weight))} opacity={dim ? 0.15 : 0.9} />;
            }
            const t = EDGE_TYPES.find((x) => x.key === e.type)!;
            const dx = tx - sx, dy = ty - sy, len = Math.hypot(dx, dy) || 1;
            const typeIdx = EDGE_TYPES.findIndex((x) => x.key === e.type);
            const bend = 16 + typeIdx * 10;
            const mx = (sx + tx) / 2 - (dy / len) * bend, my = (sy + ty) / 2 + (dx / len) * bend;
            const rt = r(e.target) + 5;
            const dd = Math.hypot(tx - mx, ty - my) || 1;
            const ex = tx - ((tx - mx) / dd) * rt, ey = ty - ((ty - my) / dd) * rt;
            const w = e.type === "cothread" ? 1 : 1.2 + (Math.log1p(e.weight) / Math.log1p(maxW)) * 3.5;
            return (
              <path key={i} d={`M${sx},${sy} Q${mx},${my} ${ex},${ey}`} fill="none" stroke={t.color} strokeWidth={w} opacity={dim ? 0.07 : e.type === "read" ? 0.55 : 0.85}
                markerEnd={e.type === "cothread" ? undefined : `url(#ah-${e.type})`}
                onMouseMove={(ev) => setTip({ x: ev.clientX, y: ev.clientY, content: <div><div className="tt-title">{e.source.label} → {e.target.label}</div><div className="tt-row"><span className="tt-key" style={{ background: t.color }} />{t.label}<span className="v">{e.weight}×</span></div><div className="muted" style={{ fontSize: 11 }}>{t.note}</div></div> })}
                onMouseLeave={() => setTip(null)} />
            );
          })}
          {graph.nodes.map((n) => {
            const dim = hover && hover !== n.id && !linked(hover, n.id);
            if (n.kind === "problem") {
              const s = r(n);
              return (
                <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={dim ? 0.25 : 1} style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => nav(`/problems/${n.id.slice(2)}`)}
                  onMouseMove={(ev) => setTip({ x: ev.clientX, y: ev.clientY, content: <div><div className="tt-title">{n.label} {n.title}</div><div className="tt-row">Posts in thread<span className="v">{n.size}</span></div></div> })}>
                  <rect x={-s} y={-s} width={s * 2} height={s * 2} rx={3} fill="var(--panel-2)" stroke="var(--ink)" strokeWidth={1.5} />
                  <text y={s + 13} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={10.5} fill="var(--ink-2)">{n.label}</text>
                </g>
              );
            }
            const c = agentColor(n.id, order);
            const subIdx = subOrder.indexOf(n.sub_id ?? "");
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={dim ? 0.3 : 1} style={{ cursor: "pointer" }}
                onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => nav(`/agents/${n.id}`)}>
                <circle r={r(n) + 5} fill="none" stroke="var(--line)" strokeDasharray={subIdx % 2 ? "3 3" : undefined}><title>subscription {subIdx + 1}</title></circle>
                <circle r={r(n)} fill={c} fillOpacity={0.16} stroke={c} strokeWidth={2} />
                <circle r={3.5} fill={c} />
                <text y={r(n) + 18} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={11.5} fontWeight={600} fill="var(--ink)" stroke="var(--panel)" strokeWidth={3} paintOrder="stroke">{n.label}</text>
                <text y={r(n) + 31} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={10} fill="var(--ink-3)" stroke="var(--panel)" strokeWidth={3} paintOrder="stroke">{n.size} posts</text>
              </g>
            );
          })}
        </svg>
      )}
      <div className="tag" style={{ paddingTop: 6 }}>Ring style marks the subscription (solid or dashed). Line width grows with the number of interactions.</div>
      <Tooltip tip={tip} />
    </div>
  );
}
