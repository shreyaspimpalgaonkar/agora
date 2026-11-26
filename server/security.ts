import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { KEYS } from "./config.js";

// Per-process random key so timing-safe HMAC comparisons do not even leak secret length.
const COMPARE_KEY = crypto.randomBytes(32);

export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ha = crypto.createHmac("sha256", COMPARE_KEY).update(a).digest();
  const hb = crypto.createHmac("sha256", COMPARE_KEY).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Strict integer parsing and clamping; rejects NaN, Infinity, floats, and out-of-range values. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Parse a strictly positive safe integer, returning null if invalid. */
export function parsePosInt(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/** Parse a Cookie header without throwing on malformed percent-encoding or '=' inside values. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const rawKey = part.slice(0, idx).trim();
    const rawVal = part.slice(idx + 1).trim();
    if (!rawKey) continue;
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal);
    } catch {
      // Ignore malformed percent-encoding instead of throwing URIError.
    }
  }
  return out;
}

/** Strip ?key=... and guarantee a relative path on this origin (blocks //evil.com and /\evil.com open redirects). */
export function safeRedirectPath(originalUrl: string): string {
  try {
    // Strip leading extra slashes before parsing so protocol-relative URLs cannot hijack host.
    const normalized = "/" + originalUrl.replace(/^[/\\]+/, "");
    const u = new URL(normalized, "http://agora.local");
    u.searchParams.delete("key");
    const cleanPath = "/" + u.pathname.replace(/^[/\\]+/, "");
    return cleanPath + (u.search || "");
  } catch {
    return "/";
  }
}

/** Sanitize a filename for Content-Disposition headers (no quotes, slashes, or CRLF). */
export function safeFilename(name: string, fallback = "download"): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return clean.slice(0, 120) || fallback;
}

/**
 * Verify that `candidatePath` is an actual regular file (never a symlink) whose realpath
 * lies strictly within `rootDir`.
 */
export function resolveSafeFile(rootDir: string, candidatePath: string): string | null {
  try {
    const lstat = fs.lstatSync(candidatePath);
    if (!lstat.isFile()) return null; // rejects symlinks, directories, FIFOs, devices
    const realRoot = fs.realpathSync(rootDir);
    const realFile = fs.realpathSync(candidatePath);
    if (realFile === realRoot || !realFile.startsWith(realRoot + path.sep)) return null;
    return realFile;
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip credentials, access keys, JWTs, API keys, and private keys before storing or streaming. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted token]")
    .replace(/\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}/g, "[redacted key]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[redacted token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted token]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted key]")
    .replace(/(\bAuthorization\s*:\s*Bearer\s+)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/("?(?:refresh|access|id|manage)_token"?\s*[:=]\s*)"?[^\s",}]{8,}"?/gi, "$1[redacted]")
    .replace(/("?(?:OPENAI_API_KEY|AGORA_RUN_TOKEN|AGORA_ADMIN_KEY|AGORA_VIEW_KEY|agora_key|x-agora-key|x-agora-token|x-agora-manage)"?\s*[:=]\s*)"?[^\s",;&}]{6,}"?/gi, "$1[redacted]");

  for (const secret of [KEYS.admin, KEYS.viewer]) {
    if (secret && secret.length >= 6 && out.includes(secret)) {
      out = out.replace(new RegExp(escapeRegExp(secret), "g"), "[redacted key]");
    }
  }
  return out;
}

/** Recursively redact all strings inside an arbitrary JSON-like payload. */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** Line-preserving Transform stream that redacts secrets from text/JSONL streams on the fly. */
export function createRedactStream(): Transform {
  let carry = "";
  return new Transform({
    decodeStrings: false,
    transform(chunk: Buffer | string, _enc, cb) {
      carry += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      if (lines.length) this.push(lines.map(redact).join("\n") + "\n");
      cb();
    },
    flush(cb) {
      if (carry) this.push(redact(carry));
      cb();
    },
  });
}

/** Lightweight fixed-window in-memory rate limiter with bounded memory. */
export function createRateLimiter(opts: { windowMs: number; max: number; maxEntries?: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const maxEntries = opts.maxEntries ?? 10_000;

  const prune = (nowMs: number) => {
    for (const [k, v] of hits) {
      if (v.resetAt <= nowMs) hits.delete(k);
    }
    if (hits.size > maxEntries) {
      const excess = hits.size - maxEntries;
      let i = 0;
      for (const k of hits.keys()) {
        hits.delete(k);
        if (++i >= excess) break;
      }
    }
  };

  setInterval(() => prune(Date.now()), Math.max(30_000, opts.windowMs)).unref();

  return {
    /** Increment count and return true if allowed, false if rate-limited. */
    consume(key: string): { allowed: boolean; retryAfterSec: number } {
      const nowMs = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= nowMs) {
        if (hits.size >= maxEntries) prune(nowMs);
        entry = { count: 0, resetAt: nowMs + opts.windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      if (entry.count > opts.max) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)) };
      }
      return { allowed: true, retryAfterSec: 0 };
    },
    /** Check without incrementing whether key is currently blocked. */
    isBlocked(key: string): { blocked: boolean; retryAfterSec: number } {
      const nowMs = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= nowMs) return { blocked: false, retryAfterSec: 0 };
      if (entry.count >= opts.max) {
        return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000)) };
      }
      return { blocked: false, retryAfterSec: 0 };
    },
  };
}
