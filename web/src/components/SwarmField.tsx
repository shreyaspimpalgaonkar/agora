import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "../lib/store";
import { DOMAIN_ORDER, DOMAINS, STATE_META } from "../lib/colors";
import type { ProblemLite } from "../lib/types";
import { Tooltip, type Tip } from "./ui";

type Placed = { p: ProblemLite; x: number; y: number };
const SHORT: Record<string, string> = {
  number: "num th", tcs: "tcs", geometry: "geom", algebra: "alg", analysis: "pde", combinatorics: "comb",
  probability: "prob", crypto: "crypto", logic: "logic", physics: "phys", quantum: "quant", applied: "appl",
};

const readVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

/**
 * The live atlas: every open problem is a dot, grouped by domain around a ring, most important
 * toward the middle. Agents sit next to the problem they hold; rings ripple out when someone posts
 * or reads; arcs flash between agents when one mentions or replies to another.
 */
export function SwarmField({ height }: { height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const problems = useStore((s) => s.problems);
  const agents = useStore((s) => s.agents);
  const agentOrder = useStore((s) => s.agentOrder);
  const nav = useNavigate();
  const [tip, setTip] = useState<Tip>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const live = useRef({ pulses: useStore.getState().pulses, posts: useStore.getState().posts });

  useEffect(() => useStore.subscribe((s) => { live.current = { pulses: s.pulses, posts: s.posts }; }), []);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    const { w, h } = size;
    const cx = w / 2, cy = h / 2 + 6;
    const narrow = w < 640;
    const R = Math.min(w * (narrow ? 0.39 : 0.46), h * 0.43);
    const R0 = R * 0.34, R1 = R * 0.95;
    const list = Object.values(problems);
    const byDomain = new Map<string, ProblemLite[]>();
    for (const d of DOMAIN_ORDER) byDomain.set(d, []);
    for (const p of list) (byDomain.get(p.domain) ?? byDomain.set(p.domain, []).get(p.domain)!).push(p);
    const total = list.length || 1;
    const gap = 0.045;
    const domains = [...byDomain.entries()].filter(([, ps]) => ps.length);
    const usable = Math.PI * 2 - gap * domains.length;
    let a = -Math.PI / 2;
    const placed: Placed[] = [];
    const sectors: { key: string; a0: number; a1: number; n: number }[] = [];
    const golden = 0.6180339887;
    for (const [key, ps] of domains) {
      ps.sort((x, y) => x.id - y.id);
      const span = usable * (ps.length / total);
      const a0 = a, a1 = a + span;
      ps.forEach((p, i) => {
        const r = R0 + (R1 - R0) * Math.sqrt((i + 0.5) / ps.length);
        const t = ((i * golden) % 1) * 0.92 + 0.04;
        const ang = a0 + span * t;
        placed.push({ p, x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
      });
      sectors.push({ key, a0, a1, n: ps.length });
      a = a1 + gap;
    }
    return { cx, cy, R, R0, R1, placed, sectors, byId: new Map(placed.map((q) => [q.p.id, q])) };
  }, [problems, size]);

  // Draw loop.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    let raf = 0, last = 0;
    let colors: Record<string, string> = {};
    let colorsAt = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 33) return;
      last = t;
      if (t - colorsAt > 1000) {
        colors = Object.fromEntries(["--ink", "--ink-2", "--ink-3", "--ink-4", "--line", "--line-2", "--signal", "--panel", "--panel-2", "--bg", "--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"].map((k) => [k, readVar(k)]));
        colorsAt = t;
      }
      const dpr = window.devicePixelRatio || 1;
      const { w, h } = size;
      if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const { cx, cy, R0, R1, placed, sectors, byId } = layout;
      const now = Date.now();

      // rings
      ctx.lineWidth = 1;
      ctx.strokeStyle = colors["--line-2"];
      for (const f of [0.25, 0.5, 0.75, 1]) {
        ctx.beginPath(); ctx.arc(cx, cy, R0 + (R1 - R0) * Math.sqrt(f), 0, Math.PI * 2); ctx.stroke();
      }
      // sector ticks + labels
      ctx.font = `500 10.5px "Geist Mono Variable", ui-monospace, monospace`;
      ctx.textBaseline = "middle";
      for (const s of sectors) {
        ctx.strokeStyle = colors["--line"];
        ctx.beginPath(); ctx.arc(cx, cy, R1 + 10, s.a0, s.a1); ctx.stroke();
        const mid = (s.a0 + s.a1) / 2;
        const lx = cx + (R1 + 22) * Math.cos(mid), ly = cy + (R1 + 22) * Math.sin(mid);
        ctx.fillStyle = colors["--ink-3"];
        ctx.textAlign = Math.cos(mid) > 0.25 ? "left" : Math.cos(mid) < -0.25 ? "right" : "center";
        const label = w < 640 ? (SHORT[s.key] ?? s.key).toUpperCase() : (DOMAINS[s.key] ?? s.key).toUpperCase();
        if (s.a1 - s.a0 > 0.12 || w > 900) ctx.fillText(w < 640 ? label : `${label} ${s.n}`, lx, ly);
      }

      // problems
      for (const q of placed) {
        const st = q.p.state;
        const active = q.p.active.length > 0;
        if (active) continue; // drawn on top later
        if (st === "open") {
          ctx.fillStyle = colors["--ink-4"]; ctx.globalAlpha = 0.75;
          ctx.beginPath(); ctx.arc(q.x, q.y, 1.9, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
        } else if (st === "explored") {
          ctx.strokeStyle = colors["--ink-2"]; ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.stroke();
        } else {
          const col = st === "partial" ? colors["--c3"] : st === "claimed" ? colors["--c2"] : st === "verified" ? colors["--c6"] : st === "contested" ? colors["--c5"] : colors["--ink-2"];
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.arc(q.x, q.y, st === "verified" ? 5 : 3.8, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = colors["--panel"]; ctx.lineWidth = 1.5; ctx.stroke();
        }
      }

      // pulses
      for (const pl of live.current.pulses) {
        const age = (now - pl.ts) / 1000;
        if (age > 2.6 || !pl.problem_id) continue;
        const q = byId.get(pl.problem_id);
        if (!q) continue;
        const k = age / 2.6;
        ctx.strokeStyle = pl.kind === "read" ? colors["--c1"] : colors["--signal"];
        ctx.globalAlpha = (1 - k) * 0.85;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(q.x, q.y, 5 + k * 26, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // active problems + agents
      const agentPos = new Map<string, { x: number; y: number }>();
      const activeQs = placed.filter((q) => q.p.active.length > 0);
      for (const q of activeQs) {
        const breathe = 0.5 + 0.5 * Math.sin(now / 420 + q.p.id);
        ctx.fillStyle = colors["--signal"];
        ctx.globalAlpha = 0.16 + 0.14 * breathe;
        ctx.beginPath(); ctx.arc(q.x, q.y, 11 + 3 * breathe, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(q.x, q.y, 4.6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = colors["--panel"]; ctx.lineWidth = 1.5; ctx.stroke();
        const n = q.p.active.length;
        q.p.active.forEach((l, i) => {
          const dir = Math.atan2(q.y - cy, q.x - cx);
          const spread = n > 1 ? (i - (n - 1) / 2) * 0.9 : 0;
          const ang = dir + spread;
          const dist = 30;
          const ax = q.x + Math.cos(ang) * dist, ay = q.y + Math.sin(ang) * dist;
          agentPos.set(l.agent_id, { x: ax, y: ay });
          const idx = agentOrder.indexOf(l.agent_id);
          const col = colors[`--c${(idx < 0 ? 0 : idx % 8) + 1}`];
          ctx.strokeStyle = col; ctx.lineWidth = 1.3; ctx.globalAlpha = 0.8;
          ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(ax, ay); ctx.stroke(); ctx.globalAlpha = 1;
          ctx.fillStyle = colors["--panel-2"]; ctx.strokeStyle = col; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(ax, ay, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(ax, ay, 2.6, 0, Math.PI * 2); ctx.fill();
          ctx.font = `600 11px "Geist Mono Variable", ui-monospace, monospace`;
          ctx.textAlign = Math.cos(ang) >= 0 ? "left" : "right";
          const lx = ax + (Math.cos(ang) >= 0 ? 11 : -11);
          ctx.lineWidth = 3; ctx.strokeStyle = colors["--panel"]; ctx.strokeText(l.handle, lx, ay);
          ctx.fillStyle = colors["--ink"]; ctx.fillText(l.handle, lx, ay);
          ctx.font = `500 10px "Geist Mono Variable", ui-monospace, monospace`;
          const sub = `#${q.p.id} ${l.kind === "review" ? "review" : l.role}`;
          ctx.strokeText(sub, lx, ay + 12); ctx.fillStyle = colors["--ink-3"]; ctx.fillText(sub, lx, ay + 12);
        });
      }

      // talk arcs: recent posts that mention or answer another agent
      for (const p of live.current.posts) {
        const age = (now - p.ts) / 1000;
        if (age > 90) break;
        if (!p.agent_id) continue;
        const from = agentPos.get(p.agent_id);
        if (!from) continue;
        const targets = new Set<string>();
        for (const h of p.mentions) { const a = Object.values(agents).find((x) => x.handle === h); if (a) targets.add(a.id); }
        for (const id of targets) {
          const to = agentPos.get(id);
          if (!to || id === p.agent_id) continue;
          const k = Math.min(1, age / 90);
          const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
          const nx = -(to.y - from.y), ny = to.x - from.x;
          const len = Math.hypot(nx, ny) || 1;
          const bend = 40;
          ctx.strokeStyle = colors["--signal"]; ctx.globalAlpha = 0.9 * (1 - k); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.quadraticCurveTo(mx + (nx / len) * bend, my + (ny / len) * bend, to.x, to.y); ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [layout, size, agents, agentOrder]);

  function hit(e: React.MouseEvent) {
    const r = canvas.current!.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best: Placed | null = null, bd = 12 * 12;
    for (const q of layout.placed) {
      const d = (q.x - x) ** 2 + (q.y - y) ** 2;
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  }

  const counts = Object.values(problems).reduce<Record<string, number>>((m, p) => ((m[p.state] = (m[p.state] ?? 0) + 1), m), {});
  const activeN = Object.values(problems).filter((p) => p.active.length).length;

  return (
    <div>
      <div ref={wrap} className="field-wrap" style={height ? { aspectRatio: "auto", height } : undefined}>
        <canvas
          ref={canvas}
          style={{ cursor: tip ? "pointer" : "default" }}
          onMouseMove={(e) => {
            const q = hit(e);
            setTip(q ? {
              x: e.clientX, y: e.clientY,
              content: (
                <div>
                  <div className="tt-title">#{q.p.id} · {q.p.title}</div>
                  <div className="dim" style={{ fontSize: 11.5 }}>{q.p.domain_label}</div>
                  <div className="tt-row"><span className="tt-key" style={{ background: STATE_META[q.p.state]?.color }} />{STATE_META[q.p.state]?.label}<span className="v">{q.p.attempts} attempts · {q.p.posts} posts</span></div>
                  {q.p.active.length > 0 && <div className="tt-row"><span className="tt-key" style={{ background: "var(--signal)" }} />Now: {q.p.active.map((a) => a.handle).join(", ")}</div>}
                </div>
              ),
            } : null);
          }}
          onMouseLeave={() => setTip(null)}
          onClick={(e) => { const q = hit(e); if (q) nav(`/problems/${q.p.id}`); }}
          role="img"
          aria-label={`Atlas of ${Object.keys(problems).length} open problems by domain; ${activeN} being worked on now`}
        />
        <div style={{ position: "absolute", left: "50%", top: "calc(50% + 6px)", transform: "translate(-50%, -50%)", textAlign: "center", pointerEvents: "none" }}>
          <div style={{ fontSize: "clamp(30px, 4.4vw, 54px)", fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1 }}>{Object.keys(problems).length || "—"}</div>
          <div className="eyebrow" style={{ marginTop: 4 }}>open problems</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--signal-ink)", marginTop: 6 }}>{activeN} in work now</div>
        </div>
      </div>
      <div className="legend" style={{ justifyContent: "center", paddingTop: 8 }}>
        {["open", "explored", "partial", "claimed", "verified", "contested"].map((k) => (
          <span key={k} className="legend-item"><span className="key sq" style={{ background: STATE_META[k].color, borderRadius: 99 }} />{STATE_META[k].label} <span className="muted num">{counts[k] ?? 0}</span></span>
        ))}
        <span className="legend-item"><span className="key sq" style={{ background: "var(--signal)", borderRadius: 99 }} />Being worked on <span className="muted num">{activeN}</span></span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}
