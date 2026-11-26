import { memo } from "react";
import { Link } from "react-router-dom";
import { hash, agentColor } from "../lib/colors";
import { useStore } from "../lib/store";

/** Each agent gets a unique radial sigil derived from its id: identity that does not rely on color alone. */
export function sigil(seed: string) {
  let h = hash(seed);
  const rnd = () => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0; return ((h ^= h >>> 16) >>> 0) / 4294967296; };
  const n = 3 + Math.floor(rnd() * 4);
  const rot = rnd() * Math.PI * 2;
  const spokes = Array.from({ length: n }, (_, i) => {
    const a = rot + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.5;
    return { a, len: 0.55 + rnd() * 0.42, node: rnd() > 0.45 };
  });
  const ring = rnd() > 0.5;
  const arc = { start: rnd() * Math.PI * 2, span: 0.8 + rnd() * 2.2 };
  return { spokes, ring, arc };
}

export const Glyph = memo(function Glyph({ id, size = 28, color, live = false }: { id: string; size?: number; color?: string; live?: boolean }) {
  const order = useStore((s) => s.agentOrder);
  const c = color ?? agentColor(id, order);
  const g = sigil(id);
  const r = 11;
  const sw = size < 20 ? 2.2 : 1.8;
  const arcPath = (() => {
    const a0 = g.arc.start, a1 = g.arc.start + g.arc.span, rr = 13.5;
    const x0 = 16 + rr * Math.cos(a0), y0 = 16 + rr * Math.sin(a0), x1 = 16 + rr * Math.cos(a1), y1 = 16 + rr * Math.sin(a1);
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${rr},${rr} 0 ${g.arc.span > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
  })();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: "none", display: "block" }}>
      <circle cx="16" cy="16" r="15.2" fill="var(--panel-2)" stroke="var(--line)" strokeWidth="0.8" />
      {g.ring && <circle cx="16" cy="16" r="4.2" fill="none" stroke={c} strokeWidth={sw * 0.8} />}
      <path d={arcPath} fill="none" stroke={c} strokeWidth={sw * 0.7} strokeLinecap="round" opacity="0.55" />
      {g.spokes.map((s, i) => {
        const x = 16 + Math.cos(s.a) * r * s.len, y = 16 + Math.sin(s.a) * r * s.len;
        return (
          <g key={i}>
            <line x1="16" y1="16" x2={x} y2={y} stroke={c} strokeWidth={sw} strokeLinecap="round" />
            {s.node && <circle cx={x} cy={y} r={size < 20 ? 2.2 : 1.9} fill={c} />}
          </g>
        );
      })}
      <circle cx="16" cy="16" r="2.3" fill={live ? "var(--signal)" : c} />
      {live && <circle cx="16" cy="16" r="2.3" fill="none" stroke="var(--signal)" strokeWidth="1"><animate attributeName="r" values="2.3;9;2.3" dur="2.2s" repeatCount="indefinite" /><animate attributeName="opacity" values="0.8;0;0.8" dur="2.2s" repeatCount="indefinite" /></circle>}
    </svg>
  );
});

export function AgentTag({ id, handle, size = 18, link = true, strong = true }: { id: string | null | undefined; handle: string; size?: number; link?: boolean; strong?: boolean }) {
  const agent = useStore((s) => (id ? s.agents[id] : undefined));
  const inner = (
    <span className="row" style={{ gap: 6, display: "inline-flex" }}>
      {id ? <Glyph id={id} size={size} live={agent?.status === "running"} /> : <SystemGlyph size={size} />}
      <span className="mono" style={{ fontWeight: strong ? 600 : 500, fontSize: 12 }}>{handle}</span>
    </span>
  );
  if (!id || !link) return inner;
  return <Link to={`/agents/${id}`} onClick={(e) => e.stopPropagation()}>{inner}</Link>;
}

export function SystemGlyph({ size = 28, human = false }: { size?: number; human?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: "none", display: "block" }}>
      <rect x="0.8" y="0.8" width="30.4" height="30.4" rx="9" fill={human ? "var(--ink)" : "var(--sunken)"} stroke="var(--line)" strokeWidth="0.8" />
      {human ? (
        <path d="M16 9.5a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2Zm-6.5 14c.9-3.4 3.5-5.2 6.5-5.2s5.6 1.8 6.5 5.2" fill="none" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" />
      ) : (
        <g fill="none" stroke="var(--ink-3)" strokeWidth="1.6"><circle cx="16" cy="16" r="6.5" strokeDasharray="2 2.6" /><circle cx="16" cy="16" r="2" fill="var(--ink-3)" stroke="none" /></g>
      )}
    </svg>
  );
}
