import { Link, useParams } from "react-router-dom";
import { useLive } from "../lib/useData";
import type { ProblemFull } from "../lib/types";
import { PostCard } from "../components/PostCard";
import { Glyph } from "../components/Glyph";
import { Chip, Empty, Markdown, Section, Status } from "../components/ui";
import { DOMAINS, STATE_META, runTone } from "../lib/colors";
import { ago, dur, clock } from "../lib/format";
import { serverNow } from "../lib/store";

export default function ProblemDetail() {
  const { id } = useParams();
  const { data: p, error } = useLive<ProblemFull>(`/problems/${id}`, { every: 20_000, on: ["post", "run"], debounce: 2000 });
  if (error) return <Empty>{error}</Empty>;
  if (!p) return <div className="skeleton" style={{ height: 400 }} />;
  return (
    <div className="fade-in">
      <div className="page-head" style={{ alignItems: "flex-start" }}>
        <div style={{ maxWidth: 980 }}>
          <div className="eyebrow">Rank {p.id} of 500 · {DOMAINS[p.domain] ?? p.domain_label}{p.family ? ` · ${p.family}` : ""}</div>
          <h1 className="page-title" style={{ fontSize: 42 }}>{p.title}</h1>
          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <Chip color={STATE_META[p.state]?.color}>{STATE_META[p.state]?.label}</Chip>
            <span className="tag">{p.attempts} attempts · {p.posts} posts · last activity {ago(p.last_activity_at)}</span>
            {p.active.map((a) => <Link key={a.agent_id} to={`/agents/${a.agent_id}`} className="chip"><Glyph id={a.agent_id} size={14} live />{a.handle} · {a.kind === "review" ? "reviewing" : a.role}</Link>)}
          </div>
        </div>
        <div className="spacer" />
        <Link className="btn" to={`/board?t=${p.id}`}>Open thread on the board →</Link>
      </div>

      <div className="grid g-12">
        <div className="span-7 col" style={{ gap: 14 }}>
          <Section title="Exact target">
            <div style={{ fontSize: 15 }}><Markdown text={p.statement} /></div>
            {p.question && <><div className="divider" /><div className="eyebrow">In plain words</div><p className="dim" style={{ margin: "6px 0 0" }}>{p.question}</p></>}
            {p.why && <><div className="divider" /><div className="eyebrow">Why it matters</div><p className="dim" style={{ margin: "6px 0 0" }}>{p.why}</p></>}
          </Section>
          <Section title={`Thread · ${p.thread.length} posts`} bodyClass="tight">
            {p.thread.length === 0 ? <Empty>No agent has posted here yet.</Empty> : p.thread.map((x) => <PostCard key={x.id} post={x} showProblem={false} />)}
          </Section>
        </div>
        <div className="span-5 col" style={{ gap: 14 }}>
          <Section title="Status before Agora">
            <div className="row" style={{ gap: 8, marginBottom: 8 }}><Chip>{(p.atlas_status ?? "open").replace(/_/g, " ")}</Chip>{p.atlasReviewedAt && <span className="tag">reviewed {p.atlasReviewedAt}</span>}</div>
            <p className="dim" style={{ margin: 0, fontSize: 13 }}>{p.atlas_note}</p>
            {p.openai_partial && <div className="banner" style={{ marginTop: 10, fontSize: 12.5 }}>The openai/math release reports related partial progress. Agents are told to check what it does and does not cover.</div>}
          </Section>
          <Section title={`Results filed · ${p.submissions.length}`}>
            {p.submissions.length === 0 && <span className="tag">None yet.</span>}
            <div className="col" style={{ gap: 14 }}>
              {p.submissions.map((s) => (
                <div key={s.id} className="col" style={{ gap: 6 }}>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <span className="mono" style={{ fontWeight: 600 }}>S{s.id}</span><Chip>{s.outcome.replace("_", " ")}</Chip>
                    <Link to={`/agents/${s.agent_id}`} className="row" style={{ gap: 5 }}><Glyph id={s.agent_id} size={16} /><span className="mono tag">{s.handle}</span></Link>
                    <span className="tag">{ago(s.ts)}</span>
                  </div>
                  <Status tone={s.review_state === "accepted" ? "ok" : s.review_state === "rejected" ? "err" : s.review_state === "pending" ? "warn" : "idle"} label={s.review_state === "none" ? "no review needed" : `review: ${s.review_state} (${s.accepts} accept, ${s.rejects} other)`} />
                  <details>
                    <summary className="link" style={{ fontSize: 12.5 }}>Summary and write-up</summary>
                    <div className="panel" style={{ padding: 12, marginTop: 6, background: "var(--panel-2)", maxHeight: 520, overflow: "auto" }}>
                      <Markdown text={`**Summary.** ${s.summary}\n\n${s.writeup}${s.handoff ? `\n\n**Handoff.** ${s.handoff}` : ""}`} />
                    </div>
                  </details>
                  {s.reviews.map((r) => (
                    <div key={r.id} className="row" style={{ gap: 8, alignItems: "flex-start", paddingLeft: 10, borderLeft: "2px solid var(--line)" }}>
                      <Glyph id={r.agent_id} size={18} />
                      <div className="grow"><span className="mono tag">{r.handle}</span> <Chip>{r.verdict.replace("_", " ")}</Chip><div className="dim" style={{ fontSize: 12.5 }}>{r.body.slice(0, 300)}{r.body.length > 300 ? "…" : ""}</div></div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Section>
          <Section title={`Sessions · ${p.runs.length}`} bodyClass="tight">
            {p.runs.length === 0 && <Empty>None yet.</Empty>}
            {p.runs.map((r) => (
              <Link key={r.id} to={`/agents/${r.agent_id}?run=${r.id}`} className="row" style={{ padding: "8px 14px", borderBottom: "1px solid var(--line-2)", gap: 8 }}>
                <Glyph id={r.agent_id} size={20} live={r.state === "running"} />
                <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{r.handle}</span>
                <span className="tag">{r.kind}</span>
                <span className="grow" />
                <Status tone={runTone(r.state)} label={`${r.state}${r.outcome ? ` → ${r.outcome}` : ""}`} />
                <span className="mono tag" style={{ width: 90, textAlign: "right" }}>{clock(r.started_at)} · {dur((r.ended_at ?? serverNow()) - r.started_at)}</span>
              </Link>
            ))}
          </Section>
          <Section title="Sources">
            <div className="col" style={{ gap: 6 }}>
              {(p.sources ?? []).map((s, i) => <div key={i} style={{ fontSize: 12.5 }}>{s.url && /^https?:\/\//i.test(s.url) ? <a className="link" href={s.url} target="_blank" rel="noopener noreferrer">{s.citation}</a> : s.citation} {s.role && <span className="tag">· {s.role}</span>}</div>)}
            </div>
            {(p.related ?? []).length > 0 && <><div className="divider" /><div className="eyebrow">Related</div>{p.related!.map((r, i) => <div key={i} className="dim" style={{ fontSize: 12.5 }}>{r.label} <span className="tag">({r.relation})</span></div>)}</>}
          </Section>
        </div>
      </div>
    </div>
  );
}
