import { create } from "zustand";
import { get, ApiError } from "./api";
import { openLive } from "./live";
import type { Agent, Activity, Post, ProblemLite, Role, Run, Stats, Sub, SysEvent } from "./types";

type Pulse = { id: number; ts: number; agent_id: string | null; problem_id: number | null; kind: string };

type State = {
  ready: boolean;
  role: Role;
  locked: boolean;
  connected: boolean;
  transport: "sse" | "poll" | "down";
  lastEventAt: number;
  serverOffset: number;
  stats: Stats | null;
  dataset: Record<string, any>;
  hub: { started_at: number; pid: number; streams: number; loops: number } | null;
  defaults: Record<string, any>;
  subs: Record<string, Sub>;
  agents: Record<string, Agent>;
  runs: Record<string, Run>;
  problems: Record<number, ProblemLite>;
  posts: Post[];
  sys: SysEvent[];
  activity: Activity[];
  statusLines: Record<string, { text: string; ts: number }>;
  pulses: Pulse[];
  agentOrder: string[];
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  loadProblems: () => Promise<void>;
};

let pulseId = 0;
const MAX_POSTS = 600;

export const useStore = create<State>((set, getState) => ({
  ready: false,
  role: null,
  locked: false,
  connected: false,
  transport: "down",
  lastEventAt: 0,
  serverOffset: 0,
  stats: null,
  dataset: {},
  hub: null,
  defaults: {},
  subs: {},
  agents: {},
  runs: {},
  problems: {},
  posts: [],
  sys: [],
  activity: [],
  statusLines: {},
  pulses: [],
  agentOrder: [],

  async load() {
    try {
      await getState().refresh();
      const [posts, sys] = await Promise.all([get<Post[]>("/posts?limit=300"), get<SysEvent[]>("/system/events?limit=200")]);
      set({ posts, sys, ready: true, locked: false });
      void getState().loadProblems();
      connect();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) set({ locked: true, ready: true });
      else { set({ ready: true }); setTimeout(() => void getState().load(), 3000); }
    }
  },

  async refresh() {
    const s = await get<any>("/state");
    const agentsAll = await get<Agent[]>("/agents?all=1");
    const agents: Record<string, Agent> = {};
    for (const a of agentsAll) agents[a.id] = a;
    const runs: Record<string, Run> = { ...getState().runs };
    for (const r of s.runs as Run[]) runs[r.id] = r;
    const subs: Record<string, Sub> = {};
    for (const x of s.subs as Sub[]) subs[x.id] = x;
    set({
      role: s.role, stats: s.stats, dataset: s.dataset, hub: s.hub, defaults: s.defaults, subs, agents, runs,
      serverOffset: s.hub.now - Date.now(),
      agentOrder: agentsAll.sort((a, b) => a.created_at - b.created_at).map((a) => a.id),
    });
  },

  async loadProblems() {
    const list = await get<ProblemLite[]>("/problems");
    const problems: Record<number, ProblemLite> = {};
    for (const p of list) problems[p.id] = p;
    set({ problems });
  },
}));

// ---------- live stream ----------

let started = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh(ms = 1500) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; void useStore.getState().refresh().catch(() => {}); }, ms);
}

function pushPulse(p: Omit<Pulse, "id">) {
  const pulses = [...useStore.getState().pulses.filter((x) => Date.now() - x.ts < 8000), { ...p, id: ++pulseId }];
  useStore.setState({ pulses: pulses.slice(-200) });
}

const handlers: Record<string, (data: any) => void> = {
  post(p: Post) {
    const s = useStore.getState();
    if (s.posts.some((x) => x.id === p.id)) return;
    useStore.setState({ posts: [p, ...s.posts].slice(0, MAX_POSTS), stats: s.stats ? { ...s.stats, posts: s.stats.posts + 1, postsLastHour: s.stats.postsLastHour + 1, agentPosts: s.stats.agentPosts + (p.author_type === "agent" ? 1 : 0) } : s.stats });
    pushPulse({ ts: Date.now(), agent_id: p.agent_id, problem_id: p.problem_id ?? (p.meta?.problem_id ?? null), kind: p.kind });
  },
  agent(a: Agent) {
    const s = useStore.getState();
    const order = s.agentOrder.includes(a.id) ? s.agentOrder : [...s.agentOrder, a.id];
    useStore.setState({ agents: { ...s.agents, [a.id]: a }, agentOrder: order });
  },
  run(r: Run) { useStore.setState({ runs: { ...useStore.getState().runs, [r.id]: r } }); },
  sub(x: Sub) { useStore.setState({ subs: { ...useStore.getState().subs, [x.id]: x } }); },
  problem(p: ProblemLite) { useStore.setState({ problems: { ...useStore.getState().problems, [p.id]: p } }); },
  sys(e: SysEvent) {
    const s = useStore.getState();
    if (s.sys.some((x) => x.id === e.id)) return;
    useStore.setState({ sys: [e, ...s.sys].slice(0, 400) });
    if (/^(sub\.|agent\.spawned|hub\.)/.test(e.kind)) scheduleRefresh();
  },
  status(x: { agent_id: string; text: string; ts: number }) {
    useStore.setState({ statusLines: { ...useStore.getState().statusLines, [x.agent_id]: { text: x.text, ts: x.ts } } });
  },
  activity(a: Activity) {
    const s = useStore.getState();
    useStore.setState({ activity: [a, ...s.activity].slice(0, 300) });
    const run = s.runs[a.run_id];
    if (a.kind === "tool" || a.kind === "command" || a.kind === "search") pushPulse({ ts: Date.now(), agent_id: a.agent_id, problem_id: run?.problem_id ?? null, kind: a.kind });
  },
  submission() { scheduleRefresh(); },
  read(r: { agent_id: string; target: string }) {
    const m = r.target.match(/^thread:(\d+)/);
    if (m) pushPulse({ ts: Date.now(), agent_id: r.agent_id, problem_id: Number(m[1]), kind: "read" });
  },
};

function connect() {
  if (started) return;
  started = true;
  openLive({
    types: Object.keys(handlers),
    onEvent: (type, data) => { useStore.setState({ lastEventAt: Date.now() }); handlers[type]?.(data); },
    onStatus: (st) => {
      const was = useStore.getState().connected;
      useStore.setState({ connected: st !== "down", transport: st });
      if (!was && st !== "down") scheduleRefresh(200);
    },
    onReset: () => {
      // The hub restarted (event ids start over): reload everything once.
      void useStore.getState().refresh();
      void get<Post[]>("/posts?limit=300").then((posts) => useStore.setState({ posts }));
      void get<SysEvent[]>("/system/events?limit=200").then((sys) => useStore.setState({ sys }));
    },
  });
  // Stats drift slowly (submissions, reviews); refresh them in the background.
  setInterval(() => scheduleRefresh(0), 30_000);
}

/** Server-aligned clock, so "3 min ago" is right even when the viewer's clock is off. */
export const serverNow = () => Date.now() + useStore.getState().serverOffset;
