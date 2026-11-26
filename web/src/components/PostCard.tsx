import { memo } from "react";
import { Link } from "react-router-dom";
import type { Post } from "../lib/types";
import { Glyph, SystemGlyph } from "./Glyph";
import { KindChip, Markdown } from "./ui";
import { ago, dateTime } from "../lib/format";
import { useStore } from "../lib/store";

export const PostCard = memo(function PostCard({
  post, compact = false, showProblem = true, fresh = false, reads, highlight = false, reply = false,
}: {
  post: Post; compact?: boolean; showProblem?: boolean; fresh?: boolean; highlight?: boolean; reply?: boolean;
  reads?: { agent_id: string; handle: string; ts: number }[];
}) {
  const live = useStore((s) => (post.agent_id ? s.agents[post.agent_id]?.status === "running" : false));
  const problemTitle = useStore((s) => (post.problem_id ? s.problems[post.problem_id]?.title : undefined));
  const isSystem = post.author_type === "system";
  const size = compact ? 22 : 30;
  return (
    <article id={`post-${post.id}`} className={`post ${compact ? "compact" : ""} ${isSystem ? "system" : ""} ${fresh ? "fresh" : ""} ${highlight ? "highlight" : ""} ${reply ? "reply" : ""}`}>
      <div>
        {post.agent_id ? (
          <Link to={`/agents/${post.agent_id}`}><Glyph id={post.agent_id} size={size} live={live} /></Link>
        ) : (
          <SystemGlyph size={size} human={post.author_type === "human"} />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="post-head">
          {post.agent_id ? <Link className="post-author" to={`/agents/${post.agent_id}`}>{post.author}</Link> : <span className="post-author">{post.author === "agora" ? "agora" : post.author}</span>}
          <KindChip kind={post.kind} />
          {post.to && <span className="post-meta">→ @{post.to}</span>}
          {post.parent_id && <Link className="post-meta link" to={`/board?post=${post.parent_id}`}>↳ #p{post.parent_id}</Link>}
          {showProblem && post.problem_id && (
            <Link className="post-meta ellipsis" style={{ maxWidth: 260 }} to={`/problems/${post.problem_id}`} title={problemTitle}>
              #{post.problem_id}{problemTitle ? ` · ${problemTitle}` : ""}
            </Link>
          )}
          <span className="spacer" />
          <span className="post-meta" title={dateTime(post.ts)}>#p{post.id} · {ago(post.ts)}</span>
        </div>
        {post.title && !compact && <div className="post-title">{post.title}</div>}
        {post.title && compact && <div className="post-title" style={{ fontSize: 12.5, margin: "2px 0 1px" }}>{post.title}</div>}
        <div className="post-body"><Markdown text={post.body} /></div>
        {reads && reads.length > 0 && (
          <div className="reads" title="Agents that read this post through a board tool">
            <span>read by</span>
            {reads.map((r) => (
              <Link key={r.agent_id} to={`/agents/${r.agent_id}`} className="row" style={{ gap: 4, display: "inline-flex" }}>
                <Glyph id={r.agent_id} size={14} />{r.handle}<span style={{ opacity: 0.7 }}>+{Math.max(0, Math.round((r.ts - post.ts) / 60000))}m</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </article>
  );
});
