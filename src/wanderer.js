// Client for the Wanderer API (https://github.com/Flomp/wanderer).
import { getSettings } from "./db.js";

let cookieCache = { key: "", cookie: "", at: 0 };

async function authHeaders(s) {
  if (s.wanderer_api_key) return { Authorization: `Bearer ${s.wanderer_api_key}` };
  if (s.wanderer_user && s.wanderer_password) {
    const key = `${s.wanderer_url}|${s.wanderer_user}|${s.wanderer_password}`;
    if (cookieCache.key === key && Date.now() - cookieCache.at < 6 * 3600e3) return { Cookie: cookieCache.cookie };
    const isEmail = s.wanderer_user.includes("@");
    const res = await fetch(`${base(s)}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [isEmail ? "email" : "username"]: s.wanderer_user, password: s.wanderer_password }),
    });
    if (!res.ok) throw new Error(`Wanderer login failed (HTTP ${res.status})`);
    const data = await res.json();
    const cookie = "pb_auth=" + encodeURIComponent(JSON.stringify({ token: data.token, model: data.record }));
    cookieCache = { key, cookie, at: Date.now() };
    return { Cookie: cookie };
  }
  throw new Error("Wanderer is not set up. Add the URL and an API key in Settings.");
}

const base = (s) => {
  if (!s.wanderer_url) throw new Error("Wanderer URL is not set.");
  return s.wanderer_url.replace(/\/+$/, "");
};

export function wandererConfigured() {
  const s = getSettings();
  return !!(s.wanderer_url && (s.wanderer_api_key || (s.wanderer_user && s.wanderer_password)));
}

/**
 * Upload one GPX. Returns {status:'pushed'|'duplicate', id}
 * Throws with .retry=true when Wanderer is busy.
 */
export async function uploadGpx(gpx, name) {
  const s = getSettings();
  const fd = new FormData();
  fd.append("file", new Blob([gpx], { type: "application/gpx+xml" }), safeFile(name) + ".gpx");
  fd.append("name", name);
  fd.append("ignoreDuplicates", "false");
  const res = await fetch(`${base(s)}/api/v1/trail/upload`, {
    method: "PUT",
    headers: await authHeaders(s),
    body: fd,
  });
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return { status: "pushed", id: body?.id };
  const msg = body?.message || body?.response?.message || `HTTP ${res.status}`;
  const dupId = body?.id || body?.response?.id || body?.data?.id;
  if (res.status === 400 && /duplicate/i.test(JSON.stringify(body || ""))) return { status: "duplicate", id: dupId };
  if (res.status === 401) cookieCache = { key: "", cookie: "", at: 0 };
  const err = new Error(`Wanderer: ${msg}`);
  err.retry = res.status === 503 || res.status === 429 || res.status >= 500;
  err.fatal = res.status === 401 || res.status === 403;
  throw err;
}

export async function testConnection() {
  const s = getSettings();
  const res = await fetch(`${base(s)}/api/v1/trail/filter`, { headers: await authHeaders(s) });
  if (res.status === 401 || res.status === 403) throw new Error("Wanderer refused the login (check the API key).");
  if (!res.ok && res.status !== 404) throw new Error(`Wanderer answered HTTP ${res.status}`);
  return true;
}

export function trailUrl(id) {
  const s = getSettings();
  return id && s.wanderer_url ? `${s.wanderer_url.replace(/\/+$/, "")}/trails` : null;
}

const safeFile = (n) => String(n || "trail").replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "trail";
