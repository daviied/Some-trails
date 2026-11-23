// Client for the Wanderer API (https://github.com/Flomp/wanderer).
import { getSettings } from "./db.js";
import { haversine, normName } from "./geo.js";

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

/**
 * Look in Wanderer for a trail that is the same as this one (also trails added by hand).
 * Same trail = same name in the same area, or about the same length starting at the same place.
 * Returns {id, name} or null. Errors return null, so an old Wanderer version does not stop uploads.
 */
export async function findWandererDuplicate(t, lines, meta = {}) {
  const s = getSettings();
  const pad = 0.003;
  const filter = `min_lat <= ${t.max_lat + pad} AND max_lat >= ${t.min_lat - pad} AND min_lon <= ${t.max_lon + pad} AND max_lon >= ${t.min_lon - pad}`;
  let hits;
  try {
    const res = await fetch(`${base(s)}/api/v1/search/trails`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders(s)) },
      body: JSON.stringify({
        q: "",
        options: { filter, limit: 200, attributesToRetrieve: ["id", "name", "distance", "min_lat", "max_lat", "min_lon", "max_lon", "_geo"] },
      }),
    });
    if (!res.ok) return null;
    hits = (await res.json()).hits || [];
  } catch {
    return null;
  }
  const nn = meta.unnamed ? "" : normName(t.name);
  const start = lines[0][0], end = lines[lines.length - 1].at(-1);
  const area = (b) => Math.max(1e-12, (b.max_lat - b.min_lat) * (b.max_lon - b.min_lon));
  for (const h of hits) {
    if (h.min_lat == null) continue;
    const ix = Math.max(0, Math.min(t.max_lon, h.max_lon) - Math.max(t.min_lon, h.min_lon));
    const iy = Math.max(0, Math.min(t.max_lat, h.max_lat) - Math.max(t.min_lat, h.min_lat));
    const overlap = (ix * iy) / Math.min(area(t), area(h)); // 1 = one box inside the other
    const sameName = nn && normName(h.name) === nn;
    const sameLen = h.distance > 0 && Math.abs(h.distance - t.length_m) <= Math.max(150, 0.15 * t.length_m);
    const g = h._geo;
    const sameStart = g && Math.min(haversine(start, [g.lng, g.lat]), haversine(end, [g.lng, g.lat])) <= 200;
    if ((sameName && overlap > 0.3) || (sameLen && sameStart && overlap > 0.6)) return { id: h.id, name: h.name };
  }
  return null;
}
