import { useEffect, useRef, useState } from "react";
import { get } from "./api";
import { useStore } from "./store";

/**
 * Fetch an endpoint and keep it fresh: refetch on an interval, and (debounced) whenever the live
 * stream reports changes of the given kinds. Holds the previous data while refetching.
 */
export function useLive<T>(path: string | null, opts: { every?: number; on?: ("post" | "run" | "agent" | "sub" | "sys" | "problem")[]; debounce?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = () => get<T>(path).then((d) => { if (alive && pathRef.current === path) { setData(d); setError(null); } }).catch((e) => alive && setError(e.message));
    load();
    const iv = setInterval(load, opts.every ?? 20_000);
    const kinds = opts.on ?? [];
    let prev = useStore.getState();
    const unsub = kinds.length ? useStore.subscribe((s) => {
      const changed =
        (kinds.includes("post") && s.posts !== prev.posts) ||
        (kinds.includes("run") && s.runs !== prev.runs) ||
        (kinds.includes("agent") && s.agents !== prev.agents) ||
        (kinds.includes("sub") && s.subs !== prev.subs) ||
        (kinds.includes("sys") && s.sys !== prev.sys) ||
        (kinds.includes("problem") && s.problems !== prev.problems);
      prev = s;
      if (changed && !timer.current) timer.current = setTimeout(() => { timer.current = null; load(); }, opts.debounce ?? 2500);
    }) : () => {};
    return () => { alive = false; clearInterval(iv); unsub(); if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return { data, error, setData };
}
