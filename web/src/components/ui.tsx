import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import { Link } from "react-router-dom";
import { kindColor, kindLabel, TONE_COLOR, type Tone } from "../lib/colors";

// ---------- status: icon + label, never color alone ----------

export function ToneIcon({ tone, size = 12 }: { tone: Tone; size?: number }) {
  const c = TONE_COLOR[tone];
  if (tone === "live") return <span className="dot live" style={{ width: size - 4, height: size - 4 }} />;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
      {tone === "ok" && <><circle cx="6" cy="6" r="5.5" fill={c} /><path d="M3.4 6.2 5.2 8l3.4-3.7" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></>}
      {tone === "warn" && <><path d="M6 .8 11.4 10.6H.6Z" fill={c} /><path d="M6 4.3v3" stroke="#3a2a00" strokeWidth="1.4" strokeLinecap="round" /><circle cx="6" cy="9" r=".8" fill="#3a2a00" /></>}
      {tone === "err" && <><rect x=".5" y=".5" width="11" height="11" rx="3" fill={c} /><path d="m3.8 3.8 4.4 4.4m0-4.4-4.4 4.4" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /></>}
      {tone === "idle" && <circle cx="6" cy="6" r="4.5" fill="none" stroke={c} strokeWidth="1.5" />}
    </svg>
  );
}

export function Status({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  return <span className="status" title={title}><ToneIcon tone={tone} />{label}</span>;
}

export function KindChip({ kind }: { kind: string }) {
  return <span className="chip"><span className="sw" style={{ background: kindColor(kind) }} />{kindLabel(kind)}</span>;
}

export function Chip({ children, color, title }: { children: ReactNode; color?: string; title?: string }) {
  return <span className="chip" title={title}>{color && <span className="sw" style={{ background: color }} />}{children}</span>;
}

// ---------- markdown with math, @mentions and #p post links ----------

function linkify(src: string) {
  // Models often write LaTeX as \( \) and \[ \]; markdown would eat those backslashes, so turn them into $ delimiters first.
  src = src
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, x) => `\n$$\n${x.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, x) => `$${x.trim()}$`);
  // Leave code spans and math alone; link @HANDLE and #p123 elsewhere.
  return src
    .split(/(```[\s\S]*?```|`[^`]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g)
    .map((part, i) => (i % 2 === 1 ? part : part
      .replace(/(^|[^\w/])@([A-Z][A-Z]+-\d+)\b/g, "$1[@$2](/agents/$2)")
      .replace(/(^|[^\w/[])#p(\d+)\b/g, "$1[#p$2](/post/$2)")
      .replace(/(^|[\s(])#(\d{1,3})\b(?![\w-])/g, "$1[#$2](/problems/$2)")))
    .join("");
}

export function isSafeHttpUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export const Markdown = memo(function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: "ignore", output: "html", trust: false, maxSize: 50, maxExpand: 200 }]]}
        components={{
          a({ href, children }) {
            if (!href) return <span>{children}</span>;
            if (href.startsWith("/agents/")) return <Link className="mention" to={href}>{children}</Link>;
            if (href.startsWith("/post/")) return <Link className="pref" to={`/board?post=${href.slice(6)}`}>{children}</Link>;
            if (href.startsWith("/problems/")) return <Link className="pref" to={href}>{children}</Link>;
            if (isSafeHttpUrl(href) || href.startsWith("mailto:")) {
              return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
            }
            return <span>{children}</span>;
          },
        }}
      >
        {linkify(text)}
      </ReactMarkdown>
    </div>
  );
});

// ---------- tooltip ----------

export type Tip = { x: number; y: number; content: ReactNode } | null;
export function Tooltip({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  useEffect(() => {
    if (!tip || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    let left = tip.x + 14, top = tip.y + 14;
    if (left + r.width > window.innerWidth - 8) left = tip.x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = tip.y - r.height - 14;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [tip]);
  if (!tip) return null;
  return createPortal(<div ref={ref} className="tooltip" style={pos}>{tip.content}</div>, document.body);
}

// ---------- modal ----------

export function Modal({ onClose, children, width }: { onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-modal="true">{children}</div>
    </div>,
    document.body,
  );
}

// ---------- misc ----------

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
}

export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn sm" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }); }}>
      {done ? "Copied" : label}
    </button>
  );
}

export function Section({ index, title, right, children, className = "", bodyClass = "" }: { index?: string; title: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        {index && <span className="panel-index">{index}</span>}
        <h2 className="h2">{title}</h2>
        <div className="spacer" />
        {right}
      </div>
      <div className={`panel-body ${bodyClass}`}>{children}</div>
    </section>
  );
}
