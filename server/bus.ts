import type { Response } from "express";
import { run } from "./db.js";
import { now as clock } from "./config.js";
import { redact, redactDeep } from "./security.js";

/**
 * Live event bus. Every change the UI cares about goes through `emit`, which fans out to
 * all open Server-Sent-Event streams. A short ring buffer lets a browser that reconnects
 * with Last-Event-ID catch up on what it missed.
 */
type BusEvent = { id: number; type: string; ts: number; data: unknown };
const MAX_CLIENTS = 200;
const MAX_WAITERS = 200;
const clients = new Set<{ res: Response; runFilter?: string }>();
const ring: BusEvent[] = [];
let seq = 0;

/** Identifies this hub process; a poller that sees it change knows ids restarted and reloads. */
export const BOOT = `${process.pid}-${Date.now()}`;
const waiters = new Set<() => void>();

export function emit(type: string, data: unknown) {
  const ev: BusEvent = { id: ++seq, type, ts: clock(), data };
  ring.push(ev);
  if (ring.length > 4000) ring.splice(0, ring.length - 4000);
  for (const w of waiters) w();
  waiters.clear();
  const line = `id: ${ev.id}\nevent: ${type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) {
    // run.event traffic is heavy; only streams opened for that run (or "all") receive it.
    if (type === "run.event" && c.runFilter !== "*" && c.runFilter !== (data as { run_id?: string }).run_id) continue;
    try { c.res.write(line); } catch { clients.delete(c); }
  }
}

const wanted = (ev: BusEvent, runFilter?: string) =>
  ev.type !== "run.event" || runFilter === "*" || runFilter === (ev.data as { run_id?: string }).run_id;

/**
 * Long-poll fallback for networks that buffer event streams (some tunnels and proxies do).
 * Returns events after `after`, waiting up to `waitMs` for the first one.
 */
export async function poll(after: number, boot: string | undefined, runFilter: string | undefined, waitMs: number, signal?: AbortSignal) {
  if (after < 0) return { boot: BOOT, last: seq, reset: false, events: [] as BusEvent[] };
  if (boot && boot !== BOOT) return { boot: BOOT, last: seq, reset: true, events: [] as BusEvent[] };
  const oldest = ring[0]?.id ?? seq + 1;
  if (after && after < oldest - 1) return { boot: BOOT, last: seq, reset: true, events: [] as BusEvent[] };
  const pick = () => ring.filter((e) => e.id > after && wanted(e, runFilter)).slice(0, 500);
  let events = pick();
  if (!events.length && waitMs > 0 && !signal?.aborted && waiters.size < MAX_WAITERS) {
    const deadline = Date.now() + waitMs;
    while (!events.length && Date.now() < deadline && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const t = setTimeout(done, Math.max(0, deadline - Date.now()));
        waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
      events = pick();
    }
  }
  return { boot: BOOT, last: events.length ? events[events.length - 1].id : Math.max(after, seq), reset: false, events };
}

export function attachStream(res: Response, lastId: number | undefined, runFilter?: string): boolean {
  if (clients.size >= MAX_CLIENTS) return false;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 2000\n\n`);
  // The client waits for this first event; if a proxy buffers the stream it never arrives and the client falls back to polling.
  res.write(`event: hello\ndata: ${JSON.stringify({ boot: BOOT, last: seq })}\n\n`);
  const client = { res, runFilter };
  clients.add(client);
  if (lastId) {
    for (const ev of ring) {
      if (ev.id <= lastId) continue;
      if (ev.type === "run.event" && runFilter !== "*" && runFilter !== (ev.data as { run_id?: string }).run_id) continue;
      res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
  }
  res.on("close", () => clients.delete(client));
  return true;
}

export const streamCount = () => clients.size;

setInterval(() => {
  for (const c of clients) {
    try { c.res.write(`: ping ${Date.now()}\n\n`); } catch { clients.delete(c); }
  }
}, 15000).unref();

/** Supervisor / reliability log. Stored and broadcast so the System view can show recoveries live. */
export function sysEvent(
  level: "info" | "ok" | "warn" | "error",
  kind: string,
  message: string,
  refs: { agent_id?: string | null; sub_id?: string | null; run_id?: string | null; problem_id?: number | null } = {},
  data: unknown = {},
) {
  const ts = clock();
  const safeMessage = redact(message);
  const safeData = redactDeep(data ?? {});
  const r = run(
    `INSERT INTO sys_events(ts,level,kind,agent_id,sub_id,run_id,problem_id,message,data) VALUES(?,?,?,?,?,?,?,?,?)`,
    ts, level, kind, refs.agent_id ?? null, refs.sub_id ?? null, refs.run_id ?? null, refs.problem_id ?? null, safeMessage, JSON.stringify(safeData),
  );
  emit("sys", { id: Number(r.lastInsertRowid), ts, level, kind, message: safeMessage, ...refs, data: safeData });
  const tag = level === "error" ? "ERR " : level === "warn" ? "WARN" : level === "ok" ? " OK " : "INFO";
  console.log(`[${new Date(ts).toISOString()}] ${tag} ${kind} ${safeMessage}`);
}

