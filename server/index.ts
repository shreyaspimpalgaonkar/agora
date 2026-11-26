import express, { type Request, type Response, type NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import { PORT, HOST, ROOT, KEYS } from "./config.js";
import { seedProblems } from "./db.js";
import { sysEvent } from "./bus.js";
import { api } from "./api.js";
import { supervisor } from "./runner/supervisor.js";
import { parseCookies, safeEqual, safeRedirectPath, createRateLimiter } from "./security.js";

seedProblems();

const app = express();
app.disable("x-powered-by");

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

// Security headers on every response.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Content-Security-Policy", CSP);
  next();
});

// Cookies, parsed safely (handles '=' inside values and malformed percent-encoding).
app.use((req, _res, next) => {
  (req as any).cookies = parseCookies(req.headers.cookie);
  next();
});

const keyRedirectLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 30 });

function isHttps(req: Request): boolean {
  if (req.secure) return true;
  const xf = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  return xf === "https";
}

// Opening any page with ?key=... stores the key in a cookie and drops it from the URL.
app.use((req, res, next) => {
  const key = typeof req.query.key === "string" ? req.query.key : undefined;
  if (key && req.method === "GET" && !req.path.startsWith("/api/")) {
    const ip = req.socket.remoteAddress ?? "unknown";
    if (safeEqual(key, KEYS.admin) || safeEqual(key, KEYS.viewer)) {
      const secureFlag = isHttps(req) ? "; Secure" : "";
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Set-Cookie", `agora_key=${encodeURIComponent(key)}; Path=/; Max-Age=${60 * 60 * 24 * 30}; HttpOnly; SameSite=Lax${secureFlag}`);
      return res.redirect(302, safeRedirectPath(req.originalUrl));
    }
    const rl = keyRedirectLimiter.consume(ip);
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return res.status(429).send("Too many requests");
    }
  }
  next();
});

app.use("/api", api);

const dist = path.join(ROOT, "web", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h", setHeaders: (res, p) => { if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); } }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

// Never leak Express stack traces or parser internals to clients (e.g., on malformed JSON bodies).
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid JSON body" });
  }
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ error: status < 500 ? (err?.message ?? "bad request") : "internal server error" });
});

const server = app.listen(PORT, HOST, () => {
  sysEvent("info", "hub.started", `Hub listening on http://${HOST}:${PORT} (pid ${process.pid})`);
  supervisor.start();
});
server.keepAliveTimeout = 65_000;
server.on("error", (e) => {
  // e.g. the port is taken: exit so the process manager can retry, instead of idling without a socket.
  console.error(`[hub] listen error: ${e.message}`);
  process.exit(1);
});

// On shutdown, leave the codex processes running: they are detached and the next hub re-attaches.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`[hub] ${sig}: exiting; agent processes keep running`);
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  });
}
process.on("uncaughtException", (e) => sysEvent("error", "hub.exception", String(e?.stack ?? e)));
process.on("unhandledRejection", (e: any) => sysEvent("error", "hub.rejection", String(e?.stack ?? e)));
