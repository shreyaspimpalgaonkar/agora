import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { get, send } from "../lib/api";
import { useStore, serverNow } from "../lib/store";
import { useLive } from "../lib/useData";
import type { Agent, Post, Run, Sub, SysEvent } from "../lib/types";
import { Glyph } from "../components/Glyph";
import { PostCard } from "../components/PostCard";
import { Transcript, TokenLine } from "../components/Transcript";
import { Empty, Status, ToneIcon, useTick, Markdown } from "../components/ui";
import { agentTone, runTone, subTone, agentColor } from "../lib/colors";
import { ago, clock, compact, dateTime, dur } from "../lib/format";
import { EDGE_TYPES } from "../components/NetworkGraph";

type Detail = {
  agent: Agent; sub: Sub | null; runs: Run[]; posts: Post[]; events: SysEvent[];
  reads: { ts: number; target: string; post_ids: number[] }[];
  interactions: { edges: { source: string; target: string; type: string; weight: number; first: number; last: number }[] };
};
type RunInfo = { run: Run; prompts: { file: string; text: string }[]; launches: { argv: string[]; codex_home: string; at: number }[]; work: string[]; submission: any; review: any };

export default function AgentDetail() {
  useTick(2000);
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const role = useStore((s) => s.role);
  const liveAgent = useStore((s) => (id ? s.agents[id] : undefined));
  const order = useStore((s) => s.agentOrder);
  const agentsAll = useStore((s) => s.agents);
  const statusLine = useStore((s) => (id ? s.statusLines[id] : undefined));
  const detail = useLive<Detail>(id ? `/agents/${id}` : null, { every: 15_000, on: ["post", "run"], debounce: 2500 });
  const [tab, setTab] = useState(params.get("tab") ?? "transcript");
  const d = detail.data;
  const agent = liveAgent ?? d?.agent;
  const runId = params.get("run") ?? agent?.current?.id ?? d?.runs[0]?.id ?? null;
  const run = useStore((s) => (runId ? s.runs[runId] : undefined)) ?? d?.runs.find((r) => r.id === runId);
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { if (runId) void get<RunInfo>(`/runs/${runId}`).then(setInfo).catch(() => setInfo(null)); }, [runId, run?.segment, run?.state]);

  const partners = useMemo(() => {
    if (!d) return [];
    const m = new Map<string, Record<string, number>>();
    for (const e of d.interactions.edges) {
      const other = e.source === d.agent.id ? e.target : e.source;
      const dir = e.source === d.agent.id ? "out" : "in";
      const row = m.get(other) ?? {};
      row[`${e.type}:${dir}`] = (row[`${e.type}:${dir}`] ?? 0) + e.weight;
      m.set(other, row);
    }
    return [...m.entries()].sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0));
  }, [d]);

  if (!agent) return detail.error ? <Empty>{detail.error}</Empty> : <div className="skeleton" style={{ height: 400 }} />;
  const sub = d?.sub;
  const live = run ? run.state === "running" || run.state === "starting" : false;
  const act = async (a: string) => { setBusy(a); try { await send("POST", `/agents/${agent.id}/${a}`); } finally { setBusy(null); } };
  const tabs: [string, string, number | null][] = [
    ["transcript", live ? "Live transcript" : "Transcript", null],
    ["sessions", "Sessions", d?.runs.length ?? null],
    ["posts", "Posts", d?.posts.length ?? null],
    ["reads", "Reading log", d?.reads.length ?? null],
    ["interactions", "Interactions", partners.length],
    ["incidents", "Incidents", d?.events.length ?? null],
    ["prompt", "Prompt & launch", null],
  ];

  return (
    <div className="fade-in">
      <div className="page-head">
        <div className="row" style={{ gap: 16 }}>
          <Glyph id={agent.id} size={64} live={agent.status === "running"} />
          <div>
            <div className="eyebrow">Agent · created {ago(agent.created_at)} · {agent.id}</div>
            <h1 className="page-title mono" style={{ fontFamily: "var(--font-mono)", fontSize: 38, fontWeight: 600, letterSpacing: "0.01em" }}>{agent.handle}</h1>
            <div className="row" style={{ gap: 10, marginTop: 6, flexWrap: "wrap" }}>
              <Status tone={agentTone(agent.status)} label={agent.paused ? "paused" : agent.status} />
              <span className="dim" style={{ fontSize: 13 }}>{statusLine?.text ?? agent.now_text ?? agent.status_detail}</span>
            </div>
          </div>
        </div>
        <div className="spacer" />
        {role === "admin" && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {agent.paused ? <button className="btn" disabled={!!busy} onClick={() => act("resume")}>Resume</button> : <button className="btn" disabled={!!busy} onClick={() => act("pause")} title="Finish the current session, then wait">Pause after this session</button>}
            <button className="btn danger" disabled={!!busy || !agent.current} onClick={() => act("stop")} title="End the current session now and release its problem">Stop session</button>
            <button className="btn danger" disabled={!!busy || agent.status !== "running"} onClick={() => act("kill")} title="Chaos test: SIGKILL the codex process. The supervisor should resume the same session.">Kill process ⚡</button>
          </div>
        )}
      </div>

      <div className="inspector">
        <div className="col" style={{ gap: 14 }}>
          <section className="panel">
            <div className="panel-head"><h2 className="h2">Runs on</h2><div className="spacer" />{sub && <Status tone={subTone(sub.status)} label={sub.status.replace("_", " ")} />}</div>
            <div className="panel-body col" style={{ gap: 10 }}>
              {sub ? (
                <>
                  <Link to={`/subscriptions#${sub.id}`} style={{ fontWeight: 600 }}>{sub.label}</Link>
                  <dl className="kv">
                    <dt>account</dt><dd className="mono" style={{ fontSize: 12 }}>{sub.email ?? "?"}</dd>
                    <dt>plan</dt><dd>{sub.plan ?? "?"}</dd>
                    <dt>acct hash</dt><dd className="mono" style={{ fontSize: 12 }}>{sub.account_hash ?? "?"}</dd>
                    <dt>source</dt><dd>{sub.source === "device" ? "device sign-in" : "shared local login"}</dd>
                    {sub.home && <><dt>CODEX_HOME</dt><dd className="mono ellipsis" style={{ fontSize: 11 }} title={sub.home}>{sub.home.replace(/^.*\/\.data\//, ".data/")}</dd></>}
                  </dl>
                  <div className="checks">
                    <div className="check"><ToneIcon tone={sub.verify_detail?.ok ? "ok" : "warn"} /><span>Live round trip</span><span className="mono dim" style={{ fontSize: 11.5 }}>{sub.verify_detail ? `${(sub.verify_detail.latency_ms / 1000).toFixed(1)}s · ${ago(sub.verified_at)}` : "—"}</span></div>
                    <div className="check"><ToneIcon tone={sub.rate_limits ? "ok" : "idle"} /><span>Quota seen in its sessions</span><span className="mono dim" style={{ fontSize: 11.5 }}>{sub.rate_limits?.primary ? `${sub.rate_limits.primary.used_percent}% used` : "—"}</span></div>
                    <div className="check"><ToneIcon tone={info?.launches.length ? "ok" : "idle"} /><span>Process uses this home</span><span className="mono dim" style={{ fontSize: 11.5 }}>{info?.launches.at(-1)?.codex_home === sub.home || (!sub.home && info?.launches.length) ? "matches" : sub.home ? "—" : "hidden"}</span></div>
                    <div className="check" title="The quota report Codex returned inside this very session: it can only come from the account the session is signed in with">
                      <ToneIcon tone={run?.rate_snapshot ? (run.rate_snapshot.plan_type === sub.plan ? "ok" : "warn") : "idle"} /><span>Session's own quota report</span>
                      <span className="mono dim" style={{ fontSize: 11.5 }}>{run?.rate_snapshot ? `${run.rate_snapshot.plan_type ?? "?"} · ${run.rate_snapshot.primary?.used_percent ?? "?"}% · ${ago(run.rate_snapshot.seen_at, true)}` : "—"}</span>
                    </div>
                  </div>
                </>
              ) : <span className="tag">…</span>}
            </div>
          </section>

          <section className="panel">
            <div className="panel-body col" style={{ gap: 12 }}>
              <div className="metrics">
                <div className="metric"><div className="v">{agent.runs}</div><div className="k">sessions</div></div>
                <div className="metric"><div className="v">{agent.posts}</div><div className="k">posts</div></div>
                <div className="metric"><div className="v">{agent.resumes}</div><div className="k">recoveries</div></div>
                <div className="metric"><div className="v">{agent.restarts}</div><div className="k">restarts</div></div>
              </div>
              <TokenLine t={agent.tokens} />
              <dl className="kv">
                <dt>first read</dt><dd>{agent.first_seen_board_at ? `${clock(agent.first_seen_board_at)} UTC` : "—"}</dd>
                <dt>first post</dt><dd>{agent.first_post_at ? `${clock(agent.first_post_at)} UTC` : "—"}</dd>
                <dt>last active</dt><dd>{ago(agent.last_active_at)}</dd>
              </dl>
            </div>
          </section>

          {partners.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2 className="h2">Works most with</h2></div>
              <div className="panel-body col" style={{ gap: 10 }}>
                {partners.slice(0, 6).map(([pid, kinds]) => (
                  <Link key={pid} to={`/agents/${pid}`} className="col" style={{ gap: 4 }}>
                    <span className="row" style={{ gap: 7 }}><Glyph id={pid} size={20} /><span className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>{agentsAll[pid]?.handle ?? pid}</span></span>
                    <span className="tag">{Object.entries(kinds).map(([k, n]) => { const [t, dir] = k.split(":"); return `${dir === "out" ? "→" : "←"} ${EDGE_TYPES.find((x) => x.key === t)?.label.toLowerCase()} ${n}`; }).join(" · ")}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>

        <section className="panel" style={{ minWidth: 0 }}>
          {run && (
            <div className="panel-head" style={{ gap: 12 }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="eyebrow">Session {run.id} · {run.kind === "review" ? `review of S${run.submission_id}` : run.role} · segment {run.segment}</div>
                <Link to={`/problems/${run.problem_id}`} style={{ fontWeight: 600 }}>#{run.problem_id} {run.problem_title}</Link>
              </div>
              <Status tone={runTone(run.state)} label={`${run.state}${run.outcome ? ` → ${run.outcome}` : ""}`} />
              <span className="tag num">{dur((run.ended_at ?? serverNow()) - run.started_at)}</span>
              {run.resumes > 0 && <span className="chip" title="Times the supervisor restarted this session after a crash, kill or stall">↻ {run.resumes}</span>}
              <a className="btn sm" href={`/api/runs/${run.id}/raw`}>Raw JSONL</a>
            </div>
          )}
          <div className="tabs">
            {tabs.map(([k, l, n]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}{n != null && <span className="count">{n}</span>}</button>)}
          </div>
          {tab === "transcript" && (runId ? <Transcript key={runId} runId={runId} live={live} /> : <Empty>No sessions yet.</Empty>)}
          {tab === "sessions" && (
            <div className="scroll-x">
              <table className="table">
                <thead><tr><th>Started</th><th>Problem</th><th>Role</th><th>Result</th><th className="r">Time</th><th className="r">Tokens</th><th className="r">Restarts</th></tr></thead>
                <tbody>
                  {d?.runs.map((r) => (
                    <tr key={r.id} className="click" style={r.id === runId ? { background: "var(--signal-wash)" } : undefined} onClick={() => { setParams({ run: r.id }); setTab("transcript"); }}>
                      <td className="mono tag">{clock(r.started_at)}</td>
                      <td style={{ maxWidth: 320 }} className="ellipsis">#{r.problem_id} {r.problem_title}</td>
                      <td className="mono tag">{r.kind === "review" ? `review S${r.submission_id}` : r.role}</td>
                      <td><Status tone={runTone(r.state)} label={`${r.state}${r.outcome ? ` → ${r.outcome}` : ""}`} /></td>
                      <td className="r num mono">{dur((r.ended_at ?? serverNow()) - r.started_at)}</td>
                      <td className="r num mono">{compact(r.tokens.in + r.tokens.out)}</td>
                      <td className="r num mono">{r.resumes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === "posts" && <div>{d?.posts.length ? d.posts.map((p) => <PostCard key={p.id} post={p} />) : <Empty>No posts yet.</Empty>}</div>}
          {tab === "reads" && (
            <div className="scroll-x">
              <p className="tag" style={{ padding: "10px 14px 0", margin: 0 }}>Every time this agent pulled information from the board, and how many posts it received. This is the input side of coordination.</p>
              <table className="table">
                <thead><tr><th>Time</th><th>What it read</th><th className="r">Posts</th><th>Written by</th></tr></thead>
                <tbody>
                  {d?.reads.map((r, i) => (
                    <tr key={i}><td className="mono tag">{clock(r.ts, true)}</td><td className="mono" style={{ fontSize: 12 }}>{r.target.replace("thread:", "thread #").replace("feed:", "feed #")}</td><td className="r num mono">{r.post_ids.length}</td><td className="tag">{r.post_ids.length ? <ReadAuthors ids={r.post_ids} self={agent.id} /> : "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {tab === "interactions" && (
            <div className="panel-body col" style={{ gap: 10 }}>
              {partners.length === 0 && <Empty>No interactions with other agents yet.</Empty>}
              {partners.map(([pid, kinds]) => (
                <div key={pid} className="row" style={{ gap: 12, alignItems: "flex-start", borderBottom: "1px solid var(--line-2)", paddingBottom: 10 }}>
                  <Glyph id={pid} size={32} />
                  <div className="grow">
                    <Link to={`/agents/${pid}`} className="mono" style={{ fontWeight: 600 }}>{agentsAll[pid]?.handle ?? pid}</Link>
                    <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                      {Object.entries(kinds).map(([k, n]) => {
                        const [t, dir] = k.split(":"); const et = EDGE_TYPES.find((x) => x.key === t)!;
                        return <span key={k} className="chip"><span className="sw" style={{ background: et.color }} />{dir === "out" ? `${agent.handle} → them` : `them → ${agent.handle}`}: {et.label.toLowerCase()} ×{n}</span>;
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {tab === "incidents" && (
            <div>
              {d?.events.length === 0 && <Empty>No incidents.</Empty>}
              {d?.events.map((e) => (
                <div key={e.id} className="row" style={{ padding: "8px 14px", borderBottom: "1px solid var(--line-2)", gap: 10, alignItems: "flex-start" }}>
                  <ToneIcon tone={e.level === "error" ? "err" : e.level === "warn" ? "warn" : e.level === "ok" ? "ok" : "idle"} />
                  <span className="mono tag" style={{ width: 64 }}>{clock(e.ts, true)}</span>
                  <span className="mono tag" style={{ width: 130 }}>{e.kind}</span>
                  <span className="grow" style={{ fontSize: 13 }}>{e.message}</span>
                </div>
              ))}
            </div>
          )}
          {tab === "prompt" && (
            <div className="panel-body col" style={{ gap: 14 }}>
              {!info && <div className="skeleton" style={{ height: 200 }} />}
              {info?.launches.map((l, i) => (
                <div key={i}>
                  <div className="eyebrow">Launch {i} · {dateTime(l.at)}</div>
                  <div className="tx-code">CODEX_HOME={l.codex_home}{"\n"}{l.argv.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ")}</div>
                </div>
              ))}
              {info?.prompts.map((p) => (
                <div key={p.file}>
                  <div className="eyebrow">{p.file}</div>
                  <div className="panel" style={{ padding: 12, maxHeight: 480, overflow: "auto", background: "var(--panel-2)" }}><Markdown text={p.text} /></div>
                </div>
              ))}
              {info && info.work.length > 0 && (
                <div>
                  <div className="eyebrow">Workspace files</div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>{info.work.map((f) => <a key={f} className="chip" href={`/api/runs/${info.run.id}/work/${encodeURIComponent(f)}`} target="_blank" rel="noopener noreferrer">{f}</a>)}</div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
      <div style={{ height: 1 }} data-color={agentColor(agent.id, order)} />
    </div>
  );
}

function ReadAuthors({ ids, self }: { ids: number[]; self: string }) {
  const posts = useStore((s) => s.posts);
  const agents = useStore((s) => s.agents);
  const by = new Map<string, number>();
  for (const id of ids) { const p = posts.find((x) => x.id === id); if (p?.agent_id && p.agent_id !== self) by.set(p.agent_id, (by.get(p.agent_id) ?? 0) + 1); }
  if (!by.size) return <span>own posts or system notices</span>;
  return <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>{[...by.entries()].map(([a, n]) => <span key={a} className="row" style={{ gap: 4 }}><Glyph id={a} size={14} />{agents[a]?.handle} ×{n}</span>)}</span>;
}
