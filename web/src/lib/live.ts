import { get, streamUrl } from "./api";

type Handler = (type: string, data: any) => void;
type Status = "sse" | "poll" | "down";
const POLL_FLAG = "agora-poll";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Live events from the hub. Prefers Server-Sent Events; if the stream's first event does not
 * arrive within a few seconds (some tunnels and proxies buffer streams), switches to long
 * polling, and remembers that choice for the rest of the session.
 */
export function openLive(opts: { run?: string; types: string[]; onEvent: Handler; onStatus?: (s: Status) => void; onReset?: () => void }): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let after = -1;
  let boot: string | undefined;
  const status = (s: Status) => opts.onStatus?.(s);
  let forcePoll = false;
  try { forcePoll = sessionStorage.getItem(POLL_FLAG) === "1"; } catch { /* ignore */ }

  const startPoll = async () => {
    status("poll");
    while (!closed) {
      try {
        const q = new URLSearchParams({ after: String(after), wait: after < 0 ? "0" : "20000" });
        if (boot) q.set("boot", boot);
        if (opts.run) q.set("run", opts.run);
        const r = await get<{ boot: string; last: number; reset: boolean; events: { id: number; type: string; data: any }[] }>(`/poll?${q}`);
        if (closed) return;
        if (r.reset) { boot = r.boot; after = r.last; opts.onReset?.(); continue; }
        boot = r.boot;
        for (const ev of r.events) if (opts.types.includes(ev.type)) opts.onEvent(ev.type, ev.data);
        after = r.last;
        status("poll");
      } catch {
        status("down");
        await sleep(2500);
      }
    }
  };

  const startSSE = () => {
    es = new EventSource(streamUrl(opts.run ? { run: opts.run } : {}));
    let hello = false;
    const fallback = setTimeout(() => {
      if (hello || closed) return;
      es?.close(); es = null;
      try { sessionStorage.setItem(POLL_FLAG, "1"); } catch { /* ignore */ }
      void startPoll();
    }, 5000);
    es.addEventListener("hello", (m) => {
      const d = JSON.parse((m as MessageEvent).data);
      if (boot && d.boot !== boot) opts.onReset?.();
      boot = d.boot; hello = true; clearTimeout(fallback); status("sse");
    });
    for (const t of opts.types) {
      es.addEventListener(t, (m) => {
        try { const ev = JSON.parse((m as MessageEvent).data); opts.onEvent(ev.type, ev.data); } catch { /* skip malformed */ }
      });
    }
    es.onerror = () => { if (hello) status("down"); };
  };

  if (forcePoll) void startPoll(); else startSSE();
  return () => { closed = true; es?.close(); };
}
