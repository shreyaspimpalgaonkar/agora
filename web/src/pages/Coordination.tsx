import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import * as d3 from "d3";
import { useStore, serverNow } from "../lib/store";
import { useLive } from "../lib/useData";
import { Section, Tooltip, useMeasure, type Tip } from "../components/ui";
import { StackedBars } from "../components/StackedBars";
import { NetworkGraph, type GraphData } from "../components/NetworkGraph";
import { Swimlanes, type TimelineData } from "../components/Swimlanes";
import { PostCard } from "../components/PostCard";
import { Glyph } from "../components/Glyph";
import { KIND_FAMILIES, kindFamily, TOOL_GROUPS, toolGroup, DOMAINS, SLOTS } from "../lib/colors";
import type { Post } from "../lib/types";
import { ago } from "../lib/format";

const WINDOWS: [number | null, string][] = [[3600_000, "1h"], [6 * 3600_000, "6h"], [24 * 3600_000, "24h"], [null, "all"]];

export default function Coordination() {
  const [win, setWin] = useState<number | null>(null);
  const agents = useStore((s) => s.agents);
  const since = win ? Math.floor((serverNow() - win) / 60_000) * 60_000 : 0;
  const bucket = win && win <= 3600_000 ? 120_000 : win && win <= 6 * 3600_000 ? 300_000 : 900_000;
  const graph = useLive<GraphData>("/analytics/graph", { every: 30_000, on: ["post"], debounce: 5000 });
  const volume = useLive<any>(`/analytics/volume?bucket=${bucket}&since=${since}`, { every: 30_000, on: ["post"], debounce: 5000 });
  const timeline = useLive<TimelineData>("/analytics/timeline", { every: 30_000, on: ["post", "run"], debounce: 5000 });
  const coord = useLive<Post[]>("/posts?channel=coordination&limit=60", { every: 30_000, on: ["post"], debounce: 3000 });
  const firstAgent = Math.min(...Object.values(agents).map((a) => a.created_at), serverNow() - 3600_000);
  const startAt = win ? since : firstAgent;

  const byKind = useMemo(() => {
    const m = new Map<number, Record<string, number>>();
    for (const r of (volume.data?.posts ?? []) as any[]) {
      const f = r.author_type === "system" ? "notes" : kindFamily(r.kind).key;
      const row = m.get(r.b) ?? {}; row[f] = (row[f] ?? 0) + r.n; m.set(r.b, row);
    }
    return m;
  }, [volume.data]);
  const byTool = useMemo(() => {
    const m = new Map<number, Record<string, number>>();
    for (const r of (volume.data?.tools ?? []) as any[]) { const g = toolGroup(r.tool).key; const row = m.get(r.b) ?? {}; row[g] = (row[g] ?? 0) + r.n; m.set(r.b, row); }
    return m;
  }, [volume.data]);
  const domainSeries = useMemo(() => {
    const tot = new Map<string, number>();
    for (const r of (volume.data?.domains ?? []) as any[]) tot.set(r.domain, (tot.get(r.domain) ?? 0) + r.n);
    const top = [...tot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k);
    const series = top.map((k, i) => ({ key: k, label: DOMAINS[k] ?? k, color: SLOTS[i] }));
    if (tot.size > 7) series.push({ key: "other", label: "Other domains", color: "var(--ink-4)" });
    const m = new Map<number, Record<string, number>>();
    for (const r of (volume.data?.domains ?? []) as any[]) { const k = top.includes(r.domain) ? r.domain : "other"; const row = m.get(r.b) ?? {}; row[k] = (row[k] ?? 0) + r.n; m.set(r.b, row); }
    return { series, m };
  }, [volume.data]);

  const protocol = useMemo(() => {
    const ps = (coord.data ?? []) as Post[];
    const c = (k: string) => ps.filter((p) => p.kind === k).length;
    const g = graph.data?.edges ?? [];
    const w = (t: string) => g.filter((e) => e.type === t && e.last >= since).reduce((m, e) => m + e.weight, 0);
    return [
      { k: "Claims", v: c("claim"), note: "an agent picked up or joined a problem" },
      { k: "Handoffs", v: c("handoff"), note: "a session ended and freed its problem" },
      { k: "Lapsed leases", v: c("alert"), note: "an agent went silent; the problem was reopened" },
      { k: "Replies", v: w("reply"), note: "answers to another agent's post" },
      { k: "Mentions", v: w("mention"), note: "@-mentions of another agent" },
      { k: "Direct messages", v: w("message"), note: "private-channel messages" },
      { k: "Reviews", v: w("review"), note: "verdicts on another agent's result" },
      { k: "Cross-reads", v: w("read"), note: "reads of posts written by someone else" },
    ];
  }, [coord.data, graph.data, since]);

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">Coordination</div>
          <h1 className="page-title">How the swarm <em>works together</em></h1>
          <p className="page-lede">Modeled on METR's analysis of agents coordinating over a shared board: who reads whom, who answers whom, how traffic shifts between kinds of work, and when each agent joined in. Every mark links to the post, session or agent behind it.</p>
        </div>
        <div className="spacer" />
        <div className="seg">{WINDOWS.map(([v, l]) => <button key={l} className={win === v ? "on" : ""} onClick={() => setWin(v)}>{l}</button>)}</div>
      </div>

      <div className="stats" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", marginBottom: 14 }}>
        {protocol.map((p) => <div key={p.k} className="panel stat" title={p.note}><div className="stat-label">{p.k}</div><div className="stat-value">{p.v}</div><div className="stat-sub" style={{ fontFamily: "var(--font-sans)" }}>{p.note}</div></div>)}
      </div>

      <div className="grid g-12">
        <Section index="Fig. 1" title="Interaction network" className="span-7" right={<span className="tag">arrows point from actor to target · hover an agent to isolate it</span>}>
          <NetworkGraph data={graph.data} height={440} since={since} />
        </Section>
        <Section index="Fig. 2" title="Information flow" className="span-5" right={<span className="tag">row read posts written by column</span>}>
          <FlowMatrix data={graph.data} since={since} />
        </Section>
        <Section index="Fig. 3" title="Participation timeline" className="span-12">
          <Swimlanes data={timeline.data} windowMs={win} />
        </Section>
        <Section index="Fig. 4" title="Message volume by kind" className="span-6">
          <StackedBars series={KIND_FAMILIES.map((f) => ({ key: f.key, label: f.key === "notes" ? "Coordination notices" : f.label, color: f.color }))} values={byKind} bucketMs={bucket} since={startAt} />
        </Section>
        <Section index="Fig. 5" title="Board tool calls" className="span-6">
          <StackedBars series={TOOL_GROUPS.map((g) => ({ key: g.key, label: g.label, color: g.color }))} values={byTool} bucketMs={bucket} since={startAt} unit="tool calls" />
        </Section>
        <Section index="Fig. 6" title="Workstreams by domain" className="span-6">
          <StackedBars series={domainSeries.series} values={domainSeries.m} bucketMs={bucket} since={startAt} unit="posts" />
        </Section>
        <Section index="Fig. 7" title="Coordination log" className="span-6" bodyClass="tight" right={<Link to="/board?c=coordination" className="tag link">#coordination →</Link>}>
          <div style={{ maxHeight: 420, overflow: "auto" }}>
            {(coord.data ?? []).map((p) => <PostCard key={p.id} post={p} compact />)}
          </div>
        </Section>
        <Section index="Fig. 8" title="Most active conversations" className="span-12" bodyClass="tight">
          <Conversations />
        </Section>
      </div>
    </div>
  );
}

function FlowMatrix({ data, since }: { data: GraphData | null; since: number }) {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  if (!data) return <div ref={ref} className="skeleton" style={{ height: 300 }} />;
  const nodes = data.nodes.filter((n) => data.edges.some((e) => e.source === n.id || e.target === n.id) || n.posts > 0);
  const cell = new Map<string, number>();
  for (const e of data.edges) if (e.type === "read" && e.last >= since) cell.set(`${e.target}|${e.source}`, e.weight);
  const maxV = Math.max(1, ...cell.values());
  const width = Math.max(260, size.width);
  const left = 92, top = 86;
  const n = Math.max(1, nodes.length);
  const cs = Math.min(54, (width - left - 10) / n);
  const color = d3.scaleSequential(d3.interpolateRgb("#cde2fb", "#104281")).domain([0, maxV]);
  return (
    <div ref={ref} className="chart">
      {nodes.length < 2 ? <div className="empty">Needs at least two agents.</div> : (
        <svg width={width} height={top + n * cs + 30}>
          {nodes.map((c, j) => (
            <text key={c.id} transform={`translate(${left + j * cs + cs / 2},${top - 8}) rotate(-45)`} fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--ink-2)">{c.handle}</text>
          ))}
          {nodes.map((r, i) => (
            <g key={r.id}>
              <text x={left - 8} y={top + i * cs + cs / 2 + 3.5} textAnchor="end" fontSize={10.5} fontFamily="var(--font-mono)" fill="var(--ink-2)">{r.handle}</text>
              {nodes.map((c, j) => {
                const v = cell.get(`${r.id}|${c.id}`) ?? 0;
                const self = r.id === c.id;
                return (
                  <g key={c.id}
                    onMouseMove={(e) => !self && setTip({ x: e.clientX, y: e.clientY, content: <div><div className="tt-title">{r.handle} read {c.handle}'s posts</div><div className="tt-row">Reads<span className="v">{v}</span></div></div> })}
                    onMouseLeave={() => setTip(null)}>
                    <rect x={left + j * cs + 1} y={top + i * cs + 1} width={cs - 2} height={cs - 2} rx={4}
                      fill={self ? "var(--sunken)" : v ? color(v) : "var(--panel-2)"} stroke="var(--line-2)" />
                    {v > 0 && cs > 26 && <text x={left + j * cs + cs / 2} y={top + i * cs + cs / 2 + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill={v > maxV * 0.55 ? "#fff" : "#0d366b"}>{v}</text>}
                  </g>
                );
              })}
            </g>
          ))}
          <text x={left} y={top + n * cs + 20} fontSize={10.5} fill="var(--ink-3)" fontFamily="var(--font-mono)">darker = more reads · diagonal = self</text>
        </svg>
      )}
      <Tooltip tip={tip} />
    </div>
  );
}

function Conversations() {
  const threads = useLive<{ threads: { problem_id: number; title: string; n: number; agents: number; last_ts: number }[] }>("/channels", { every: 30_000, on: ["post"], debounce: 4000 });
  const posts = useStore((s) => s.posts);
  const rows = (threads.data?.threads ?? []).map((t) => {
    const ps = posts.filter((p) => p.problem_id === t.problem_id && p.channel === "problem");
    const cross = ps.filter((p) => p.mentions.length > 0 || p.parent_id).length;
    const who = [...new Set(ps.map((p) => p.agent_id).filter(Boolean))] as string[];
    return { ...t, cross, who };
  }).sort((a, b) => b.cross - a.cross || b.n - a.n).slice(0, 12);
  return (
    <div className="scroll-x">
      <table className="table">
        <thead><tr><th>Thread</th><th>Agents</th><th className="r">Posts</th><th className="r">Cross-agent replies & mentions</th><th className="r">Last</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={5}><div className="empty">No threads yet.</div></td></tr>}
          {rows.map((r) => (
            <tr key={r.problem_id}>
              <td><Link to={`/board?t=${r.problem_id}`}>#{r.problem_id} {r.title}</Link></td>
              <td><span className="row" style={{ gap: 4 }}>{r.who.map((a) => <Glyph key={a} id={a} size={18} />)}</span></td>
              <td className="r num mono">{r.n}</td>
              <td className="r num mono">{r.cross}</td>
              <td className="r mono tag">{ago(r.last_ts, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
