import { StrictMode, useEffect, useState, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "@fontsource/doto/800.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "katex/dist/katex.min.css";
import "./styles/app.css";
import { useStore } from "./lib/store";
import { login } from "./lib/api";
import { Shell } from "./components/Shell";
import Overview from "./pages/Overview";

const Board = lazy(() => import("./pages/Board"));
const Agents = lazy(() => import("./pages/Agents"));
const AgentDetail = lazy(() => import("./pages/AgentDetail"));
const Coordination = lazy(() => import("./pages/Coordination"));
const Problems = lazy(() => import("./pages/Problems"));
const ProblemDetail = lazy(() => import("./pages/ProblemDetail"));
const Subscriptions = lazy(() => import("./pages/Subscriptions"));
const System = lazy(() => import("./pages/System"));

function Locked() {
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const k = key.trim();
    if (!k) return;
    setBusy(true); setErr(null);
    try {
      await login(k);
      location.reload();
    } catch (ex: any) {
      setErr(ex?.message ?? "Invalid access key");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="panel" style={{ width: "min(440px, 100%)", padding: 24 }}>
        <div className="brand-word" style={{ fontSize: 34 }}>agora</div>
        <p className="dim" style={{ fontSize: 14 }}>A swarm of Codex agents working on the 412 open math problems that are left. This instance is private: open the link you were given, or paste its access key.</p>
        <form className="row" onSubmit={onSubmit}>
          <input className="input grow" type="password" autoComplete="current-password" placeholder="access key" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
          <button className="btn primary" type="submit" disabled={busy || !key.trim()}>{busy ? "…" : "Enter"}</button>
        </form>
        {err && <div className="banner err" style={{ marginTop: 12, fontSize: 13 }}>{err}</div>}
      </div>
    </div>
  );
}

function ScrollTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

function App() {
  const ready = useStore((s) => s.ready);
  const locked = useStore((s) => s.locked);
  useEffect(() => { void useStore.getState().load(); }, []);
  if (!ready) return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}><span className="brand-word" style={{ fontSize: 30, opacity: 0.5 }}>agora</span></div>;
  if (locked) return <Locked />;
  return (
    <Shell>
      <ScrollTop />
      <Suspense fallback={<div className="skeleton" style={{ height: 320 }} />}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/board" element={<Board />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/agents/:id" element={<AgentDetail />} />
          <Route path="/coordination" element={<Coordination />} />
          <Route path="/problems" element={<Problems />} />
          <Route path="/problems/:id" element={<ProblemDetail />} />
          <Route path="/subscriptions" element={<Subscriptions />} />
          <Route path="/system" element={<System />} />
          <Route path="*" element={<div className="empty">Nothing here.</div>} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
