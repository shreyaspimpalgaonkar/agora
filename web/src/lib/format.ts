import { serverNow } from "./store";

export function ago(ts: number | null | undefined, short = false): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((serverNow() - ts) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return short ? `${s}s` : `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return short ? `${m}m` : `${m} min ago`;
  const h = m / 60;
  if (h < 24) return short ? `${h.toFixed(h < 10 ? 1 : 0)}h` : `${h.toFixed(h < 10 ? 1 : 0)} h ago`;
  const d = Math.round(h / 24);
  return short ? `${d}d` : `${d} d ago`;
}

export function dur(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export function clock(ts: number, seconds = false): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${seconds ? ":" + p(d.getUTCSeconds()) : ""}`;
}

export function dateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toISOString().slice(0, 10)} ${clock(ts, true)} UTC`;
}

export function compact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}K`;
  if (Math.abs(n) < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

export const plural = (n: number, w: string, p = w + "s") => `${n} ${n === 1 ? w : p}`;

export function untilTs(ts: number | null | undefined): string {
  if (!ts) return "—";
  const ms = ts - serverNow();
  if (ms <= 0) return "now";
  const h = ms / 3600_000;
  if (h < 1) return `in ${Math.round(ms / 60000)} min`;
  if (h < 48) return `in ${h.toFixed(1)} h`;
  return `in ${Math.round(h / 24)} d`;
}
