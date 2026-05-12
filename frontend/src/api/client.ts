/**
 * In `npm run dev`, empty base uses Vite's proxy → Flask :5000.
 * In production builds (`vite preview` / static hosting), there is no proxy unless configured;
 * default to Flask directly (CORS must allow the frontend origin — backend uses * for /api).
 */
const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ||
  (import.meta.env.DEV ? "" : "http://127.0.0.1:5000");

const TOKEN_KEY = "trucert_token";
const ROLE_KEY = "trucert_role";

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredRole(): string | null {
  return localStorage.getItem(ROLE_KEY);
}

export function persistAuth(token: string, role: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(ROLE_KEY, role);
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(ROLE_KEY);
}

type ApiOptions = {
  method?: string;
  json?: unknown;
  headers?: HeadersInit;
};

/** Thrown by {@link apiJson} / {@link apiFormData} on non-OK responses when the body is JSON. */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly errorCode?: string;
  constructor(message: string, status: number, errorCode?: string) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
    this.errorCode = errorCode;
  }
}

/** Shown on HTTP 404 for `/api/...` — usually wrong origin, missing proxy, or an older API build. */
export function apiPathNotFoundMessage(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return (
    `404 for ${p}. Nothing on this origin handled that URL. ` +
    `Use npm run dev (Vite proxies /api → port 5000), npm run preview with the backend on :5000, ` +
    `or set VITE_API_BASE at build time to your API. If you already run Flask here, restart it ` +
    `so it picks up the latest routes.`
  );
}

export async function apiJson<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = "GET", json, headers: hdrs } = options;
  const headers: Record<string, string> = { ...(hdrs as Record<string, string>) };
  const token = getStoredToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; error_code?: string };
  if (!res.ok) {
    if (res.status === 404 && path.startsWith("/api")) {
      throw new Error(apiPathNotFoundMessage(path));
    }
    const msg = data.error || res.statusText || "Request failed";
    throw new ApiHttpError(msg, res.status, data.error_code);
  }
  return data as T;
}

/** Authenticated GET for binary or non-JSON responses (e.g. CSV export). */
/** POST multipart (no Content-Type header — browser sets boundary). Auth header when logged in. */
export async function apiFormData<T>(path: string, form: FormData, options: { method?: string } = {}): Promise<T> {
  const method = options.method ?? "POST";
  const headers: Record<string, string> = {};
  const token = getStoredToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: form });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; error_code?: string };
  if (!res.ok) {
    const msg = data.error || res.statusText || "Request failed";
    throw new ApiHttpError(msg, res.status, data.error_code);
  }
  return data as T;
}

export async function apiDownload(path: string): Promise<{ blob: Blob; filename: string }> {
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { method: "GET", headers });
  const cd = res.headers.get("Content-Disposition") || "";
  const m = /filename="([^"]+)"/.exec(cd);
  const filename = m?.[1] || "download.csv";
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error || res.statusText || "Download failed");
  }
  const blob = await res.blob();
  return { blob, filename };
}

export { API_BASE };
