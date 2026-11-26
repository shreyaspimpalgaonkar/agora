// Thin fetch wrapper. Auth uses an HttpOnly SameSite=Lax cookie set either by opening a page
// with ?key=... or by posting to /api/auth/login from the lock screen (never kept in localStorage).
const LEGACY_KEY_LS = "agora-key";
const MANAGE_LS = "agora-manage";

// Clear any legacy plaintext access key previously saved in localStorage.
try { localStorage.removeItem(LEGACY_KEY_LS); } catch { /* private mode */ }

export function manageTokens(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(MANAGE_LS) ?? "{}"); } catch { return {}; }
}
export function rememberManageToken(subId: string, token: string) {
  try { localStorage.setItem(MANAGE_LS, JSON.stringify({ ...manageTokens(), [subId]: token })); } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function login(key: string): Promise<{ role: "admin" | "viewer" }> {
  return send("POST", "/auth/login", { key });
}

export async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export async function send<T = any>(method: "POST" | "PATCH" | "DELETE", path: string, data?: unknown, subId?: string): Promise<T> {
  const extra: Record<string, string> = { "content-type": "application/json" };
  if (subId) { const t = manageTokens()[subId]; if (t) extra["x-agora-manage"] = t; }
  const res = await fetch(`/api${path}`, { method, headers: extra, body: data === undefined ? undefined : JSON.stringify(data), credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export function streamUrl(params: Record<string, string> = {}) {
  const q = new URLSearchParams(params);
  const s = q.toString();
  return `/api/stream${s ? "?" + s : ""}`;
}
