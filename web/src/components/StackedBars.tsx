import { useState } from "react";
import * as d3 from "d3";
import { clock } from "../lib/format";
import { serverNow } from "../lib/store";
import { Tooltip, useMeasure, type Tip } from "./ui";

export type Series = { key: string; label: string; color: string };

/** Stacked columns over time: one column per bucket, 2px surface gaps, rounded data end, per-column hover. */
export function StackedBars({
  series, values, bucketMs, since, height = 200, unit = "posts", legend = true,
}: {
  series: Series[]; values: Map<number, Record<string, number>>; bucketMs: number; since: number; height?: number; unit?: string; legend?: boolean;
}) {
  const [ref, size] = useMeasure<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const width = Math.max(300, size.width);
  const now = serverNow();
  const start = Math.floor(since / bucketMs) * bucketMs;
  const buckets: number[] = [];
  for (let b = start; b <= now; b += bucketMs) buckets.push(b);
  if (buckets.length > 400) buckets.splice(0, buckets.length - 400);
  const shown = series.filter((s) => !off.has(s.key));
  const totals = buckets.map((b) => shown.reduce((m, s) => m + (values.get(b)?.[s.key] ?? 0), 0));
  const maxV = Math.max(4, d3.max(totals) ?? 0);
  const m = { l: 34, r: 8, t: 8, b: 24 };
  const x = d3.scaleBand<number>().domain(buckets).range([m.l, width - m.r]).paddingInner(0.18);
  const y = d3.scaleLinear().domain([0, maxV]).nice(4).range([height - m.b, m.t]);
  const bw = Math.min(24, x.bandwidth());
  const yt = y.ticks(4);
  const every = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor((width - 60) / 70))));

  return (
    <div ref={ref} className="chart">
      {legend && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key} className={`legend-item toggle ${off.has(s.key) ? "off" : ""}`} onClick={() => setOff((o) => { const n = new Set(o); n.has(s.key) ? n.delete(s.key) : n.add(s.key); return n; })}>
              <span className="key sq" style={{ background: s.color }} />{s.label}
            </span>
          ))}
        </div>
      )}
      <svg width={width} height={height} onMouseLeave={() => setTip(null)} role="img" aria-label={`${unit} per ${Math.round(bucketMs / 60000)} minutes`}>
        <g className="grid">{yt.map((t) => <line key={t} x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} />)}</g>
        <g className="axis">
          {yt.map((t) => <text key={t} x={m.l - 6} y={y(t) + 3} textAnchor="end">{t}</text>)}
          {buckets.map((b, i) => i % every === 0 ? <text key={b} x={(x(b) ?? 0) + x.bandwidth() / 2} y={height - 6} textAnchor="middle">{clock(b)}</text> : null)}
          <line x1={m.l} x2={width - m.r} y1={y(0)} y2={y(0)} />
        </g>
        {buckets.map((b, i) => {
          const v = values.get(b) ?? {};
          let acc = 0;
          const cx = (x(b) ?? 0) + (x.bandwidth() - bw) / 2;
          const segs = shown.map((s) => {
            const n = v[s.key] ?? 0;
            if (!n) return null;
            const y0 = y(acc), y1 = y(acc + n);
            acc += n;
            return { s, n, y0, y1 };
          }).filter(Boolean) as { s: Series; n: number; y0: number; y1: number }[];
          return (
            <g key={b}
              onMouseMove={(e) => totals[i] > 0 && setTip({ x: e.clientX, y: e.clientY, content: (
                <div>
                  <div className="tt-title">{clock(b)}–{clock(b + bucketMs)} UTC · {totals[i]} {unit}</div>
                  {segs.slice().reverse().map((g) => <div key={g.s.key} className="tt-row"><span className="tt-key" style={{ background: g.s.color }} />{g.s.label}<span className="v">{g.n}</span></div>)}
                </div>) })}
              onMouseLeave={() => setTip(null)}>
              <rect x={x(b)} y={m.t} width={x.bandwidth()} height={height - m.t - m.b} fill="transparent" />
              {segs.map((g, k) => {
                const top = k === segs.length - 1;
                const h = Math.max(1, g.y0 - g.y1 - (k > 0 ? 2 : 0));
                const yy = g.y1;
                return top
                  ? <path key={g.s.key} d={roundTop(cx, yy, bw, h, Math.min(4, h, bw / 2))} fill={g.s.color} />
                  : <rect key={g.s.key} x={cx} y={yy} width={bw} height={h} fill={g.s.color} />;
              })}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

function roundTop(x: number, y: number, w: number, h: number, r: number) {
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
