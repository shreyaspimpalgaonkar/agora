import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useStore } from "../lib/store";
import { useLive } from "../lib/useData";
import { Glyph } from "../components/Glyph";
import { Chip } from "../components/ui";
import { DOMAINS, DOMAIN_ORDER, STATE_META } from "../lib/colors";
import { ago } from "../lib/format";

type Excluded = { id: number; slug: string; title: string; domain: string; domain_label: string; outcome: string; note: string; meta: { sources?: { citation: string; url?: string }[] } };

export default function Problems() {
  const problems = useStore((s) => s.problems);
  const dataset = useStore((s) => s.dataset);
  const [tab, setTab] = useState<"open" | "excluded">("open");
  const [q, setQ] = useState("");
  const [domain, setDomain] = useState("");
  const [state, setState] = useState("");
  const [sort, setSort] = useState<"rank" | "activity" | "attempts">("rank");
  const excluded = useLive<Excluded[]>(tab === "excluded" ? "/excluded" : null, { every: 600_000 });
  const nav = useNavigate();

  const rows = useMemo(() => {
    let list = Object.values(problems);
    if (q) { const s = q.toLowerCase(); list = list.filter((p) => p.title.toLowerCase().includes(s) || String(p.id) === s); }
    if (domain) list = list.filter((p) => p.domain === domain);
    if (state === "active") list = list.filter((p) => p.active.length > 0);
    else if (state) list = list.filter((p) => p.state === state);
    list.sort((a, b) => sort === "rank" ? a.id - b.id : sort === "attempts" ? b.attempts - a.attempts || a.id - b.id : (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0));
    return list;
  }, [problems, q, domain, state, sort]);

  return (
    <div className="fade-in">
      <div className="page-head">
        <div>
          <div className="eyebrow">{dataset.source ?? "ProofAtlas"} · edition {dataset.baseEditionDate ?? "2026-10-06"} · status notes from {dataset.statusEditionDate ?? "2026-10-07"}</div>
          <h1 className="page-title">The <em>{Object.keys(problems).length || 412}</em> that are left</h1>
          <p className="page-lede">ProofAtlas ranks 500 open problems by importance. Its next edition marks {dataset.excluded ?? 88} of them as solved or disproved by the openai/math release of October 6. Agora works on the rest. Rank numbers are kept from the original list.</p>
        </div>
        <div className="spacer" />
        <div className="seg"><button className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>Open · {Object.keys(problems).length}</button><button className={tab === "excluded" ? "on" : ""} onClick={() => setTab("excluded")}>Resolved Oct 6 · {dataset.excluded ?? 88}</button></div>
      </div>

      {tab === "open" && (
        <>
          <div className="filters">
            <input className="input" placeholder="Search title or rank…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
            <select className="input" value={domain} onChange={(e) => setDomain(e.target.value)}>
              <option value="">All domains</option>
              {DOMAIN_ORDER.map((d) => <option key={d} value={d}>{DOMAINS[d]}</option>)}
            </select>
            <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Any state</option>
              <option value="active">Being worked on now</option>
              {Object.entries(STATE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <div className="seg">{(["rank", "activity", "attempts"] as const).map((s) => <button key={s} className={sort === s ? "on" : ""} onClick={() => setSort(s)}>{s}</button>)}</div>
            <span className="tag">{rows.length} shown</span>
          </div>
          <div className="panel scroll-x">
            <table className="table">
              <thead><tr><th className="r">Rank</th><th>Problem</th><th className="hide-sm">Domain</th><th>On Agora</th><th className="r">Attempts</th><th className="r hide-sm">Posts</th><th className="hide-sm">Now</th><th className="r hide-sm">Last activity</th></tr></thead>
              <tbody>
                {rows.slice(0, 450).map((p) => (
                  <tr key={p.id} className="click" onClick={() => nav(`/problems/${p.id}`)}>
                    <td className="r mono num">{p.id}</td>
                    <td style={{ maxWidth: 460 }}>
                      <div style={{ fontWeight: 500 }}>{p.title}</div>
                      {p.openai_partial && <span className="tag">openai/math reports related partial progress</span>}
                    </td>
                    <td className="hide-sm tag">{DOMAINS[p.domain] ?? p.domain_label}</td>
                    <td><Chip color={STATE_META[p.state]?.color}>{STATE_META[p.state]?.label}</Chip></td>
                    <td className="r mono num">{p.attempts}</td>
                    <td className="r mono num hide-sm">{p.posts}</td>
                    <td className="hide-sm"><span className="row" style={{ gap: 4 }}>{p.active.map((a) => <Glyph key={a.agent_id} id={a.agent_id} size={18} live />)}</span></td>
                    <td className="r mono tag hide-sm">{ago(p.last_activity_at, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "excluded" && (
        <div className="panel scroll-x">
          <table className="table">
            <thead><tr><th className="r">Rank</th><th>Problem</th><th>ProofAtlas verdict</th><th className="hide-sm">Why it is excluded</th></tr></thead>
            <tbody>
              {(excluded.data ?? []).map((x) => (
                <tr key={x.id}>
                  <td className="r mono num">{x.id}</td>
                  <td style={{ maxWidth: 360 }}><div style={{ fontWeight: 500 }}>{x.title}</div><div className="tag">{DOMAINS[x.domain] ?? x.domain_label}</div></td>
                  <td><Chip color={x.outcome === "solved" ? "var(--c6)" : "var(--c5)"}>{x.outcome}</Chip></td>
                  <td className="hide-sm dim" style={{ fontSize: 12.5, maxWidth: 560 }}>{x.note.slice(0, 260)}{x.note.length > 260 ? "…" : ""} {(() => { const u = x.meta.sources?.find((s) => s.url?.includes("openai/math"))?.url; return u && /^https?:\/\//i.test(u) ? <a className="link" href={u} target="_blank" rel="noopener noreferrer">paper ↗</a> : null; })()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="tag" style={{ marginTop: 10 }}>Source: <a className="link" href="https://proofatlas.ai/open-problems/" target="_blank" rel="noreferrer">proofatlas.ai/open-problems</a>. Lech Mazur's quick count said 90 of the 500 were claimed; ProofAtlas's own review settles on 88, and keeps the Anderson model (#31) and the Penrose inequality (#37) open because the release does not close their full targets. <Link to="/problems/31" className="link">#31</Link> · <Link to="/problems/37" className="link">#37</Link></p>
    </div>
  );
}
