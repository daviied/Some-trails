import express from "express";
import multer from "multer";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { db, getSettings, setSettings } from "./db.js";
import { parseBbox, tilesForBbox, simplify } from "./geo.js";
import { createJob, tileCoverage, kickJobs, kickPush, state, addUploadedTrail } from "./jobs.js";
import { buildGpx, parseGpx } from "./gpx.js";
import { testConnection, wandererConfigured } from "./wanderer.js";
import { fetchRetry } from "./http.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));

// Optional password for the companion UI (HTTP basic auth).
const APP_PASSWORD = process.env.APP_PASSWORD;
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === "/manifest.webmanifest" || req.path.startsWith("/icons/")) return next();
    const h = req.headers.authorization || "";
    const [, b64] = h.split(" ");
    const pass = b64 ? Buffer.from(b64, "base64").toString().split(":").slice(1).join(":") : "";
    const a = Buffer.from(pass), b = Buffer.from(APP_PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Trail Fetcher"').status(401).send("Login required");
  });
}

app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/vendor/leaflet", express.static(path.join(__dirname, "..", "node_modules", "leaflet", "dist")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 200 } });
const AUTO_FETCH_MAX_TILES = Number(process.env.AUTO_FETCH_MAX_TILES || 16);

const lite = (t, detail) => ({
  id: t.id, name: t.name, source: t.source, length_m: t.length_m,
  status: t.push_status, error: t.push_error, wanderer_id: t.wanderer_id,
  bbox: [t.min_lon, t.min_lat, t.max_lon, t.max_lat],
  lines: detail ? JSON.parse(t.lines).map((l) => simplify(l, detail)) : undefined,
});

// Search / browse. Returns cached trails right away; fetches missing tiles in the background.
app.get("/api/trails", (req, res) => {
  const bbox = parseBbox(req.query.bbox);
  const qtext = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 500, 3000);
  const detail = req.query.geom === "0" ? 0 : Number(req.query.tol) || 0.0001;
  let rows;
  if (bbox) {
    rows = db.prepare(`SELECT * FROM trails WHERE max_lon>=? AND min_lon<=? AND max_lat>=? AND min_lat<=? ${qtext ? "AND lower(name) LIKE ?" : ""} ORDER BY length_m DESC LIMIT ?`)
      .all(...[bbox.minLon, bbox.maxLon, bbox.minLat, bbox.maxLat, ...(qtext ? [`%${qtext}%`] : []), limit]);
  } else if (qtext) {
    rows = db.prepare("SELECT * FROM trails WHERE lower(name) LIKE ? ORDER BY length_m DESC LIMIT ?").all(`%${qtext}%`, limit);
  } else {
    rows = [];
  }
  let coverage = null, jobId = null;
  if (bbox) {
    coverage = tileCoverage(bbox);
    const want = req.query.fetch !== "0";
    if (want && coverage.cached < coverage.tiles && coverage.tiles <= AUTO_FETCH_MAX_TILES) {
      const running = db.prepare("SELECT id, bbox FROM jobs WHERE status IN ('queued','running')").all()
        .find((j) => { const b = JSON.parse(j.bbox); return b.minLon <= bbox.minLon && b.maxLon >= bbox.maxLon && b.minLat <= bbox.minLat && b.maxLat >= bbox.maxLat; });
      jobId = running ? running.id : Number(createJob(bbox, "Browse", true));
    }
  }
  res.json({ trails: rows.map((t) => lite(t, detail)), coverage, jobId, autoFetchMaxTiles: AUTO_FETCH_MAX_TILES });
});

app.get("/api/trails/:id", (req, res) => {
  const t = db.prepare("SELECT * FROM trails WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({ error: "Not found" });
  res.json({ ...lite(t, 0.00002), meta: JSON.parse(t.meta || "{}"), fetched_at: t.fetched_at, pushed_at: t.pushed_at });
});

app.get("/api/trails/:id/gpx", (req, res) => {
  const t = db.prepare("SELECT * FROM trails WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).end();
  res.type("application/gpx+xml").attachment(`${t.name.replace(/[^\w\- ]+/g, "") || "trail"}.gpx`)
    .send(buildGpx({ name: t.name, lines: JSON.parse(t.lines) }));
});

app.post("/api/trails/:id/push", (req, res) => {
  const r = db.prepare("UPDATE trails SET push_status='queued', push_error=NULL WHERE id=?").run(req.params.id);
  kickPush();
  res.json({ ok: r.changes > 0 });
});

// Push all not-yet-pushed trails in an area (or retry errors).
app.post("/api/push", (req, res) => {
  const bbox = parseBbox(req.body?.bbox);
  const statuses = req.body?.retryErrors ? ["new", "error"] : ["new"];
  const ph = statuses.map(() => "?").join(",");
  const r = bbox
    ? db.prepare(`UPDATE trails SET push_status='queued', push_error=NULL WHERE push_status IN (${ph}) AND max_lon>=? AND min_lon<=? AND max_lat>=? AND min_lat<=?`).run(...statuses, bbox.minLon, bbox.maxLon, bbox.minLat, bbox.maxLat)
    : db.prepare(`UPDATE trails SET push_status='queued', push_error=NULL WHERE push_status IN (${ph})`).run(...statuses);
  kickPush();
  res.json({ queued: r.changes });
});

// Import a whole area (the map box).
app.post("/api/jobs", (req, res) => {
  const bbox = parseBbox(req.body?.bbox);
  if (!bbox) return res.status(400).json({ error: "Bad bbox" });
  try {
    const id = createJob(bbox, String(req.body.label || "Area").slice(0, 120), req.body.push !== false);
    res.json({ id, tiles: tilesForBbox(bbox).length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/jobs", (req, res) => {
  res.json(db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 30").all());
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  db.prepare("UPDATE jobs SET status='cancelled', message='Cancelled' WHERE id=? AND status IN ('queued','running')").run(req.params.id);
  res.json({ ok: true });
});

app.post("/api/jobs/:id/retry", (req, res) => {
  db.prepare("UPDATE jobs SET status='queued', done=0, message='' WHERE id=?").run(req.params.id);
  kickJobs();
  res.json({ ok: true });
});

app.get("/api/status", (req, res) => {
  const counts = Object.fromEntries(db.prepare("SELECT push_status s, count(*) n FROM trails GROUP BY push_status").all().map((r) => [r.s, r.n]));
  const bySource = Object.fromEntries(db.prepare("SELECT source s, count(*) n FROM trails GROUP BY source").all().map((r) => [r.s, r.n]));
  res.json({
    counts, bySource,
    wanderer: wandererConfigured(),
    pushRunning: state.pushRunning, pushPaused: state.pushPaused, lastPushError: state.lastPushError,
    jobRunning: state.jobRunning, currentJob: state.currentJob,
  });
});

// Place search -> bounding box (Nominatim). Cached in memory.
const geoCache = new Map();
app.get("/api/geocode", async (req, res) => {
  const qtext = String(req.query.q || "").trim();
  if (!qtext) return res.json([]);
  if (geoCache.has(qtext)) return res.json(geoCache.get(qtext));
  try {
    const url = `${process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org"}/search?format=jsonv2&limit=6&q=${encodeURIComponent(qtext)}`;
    const r = await fetchRetry(url, {}, { tries: 2, timeout: 15000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const out = (await r.json()).map((p) => ({
      name: p.display_name, type: p.type,
      bbox: [Number(p.boundingbox[2]), Number(p.boundingbox[0]), Number(p.boundingbox[3]), Number(p.boundingbox[1])],
    }));
    geoCache.set(qtext, out);
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: "Place search failed: " + e.message });
  }
});

// GPX uploads (exports from AllTrails, Gaia, Strava, etc.)
app.post("/api/upload", upload.array("files"), (req, res) => {
  const results = [];
  for (const f of req.files || []) {
    try {
      const xml = f.buffer.toString("utf8");
      const g = parseGpx(xml);
      if (!g.lines.length) throw new Error("No track points");
      const name = g.name || f.originalname.replace(/\.gpx$/i, "");
      const key = crypto.createHash("sha1").update(JSON.stringify(g.lines)).digest("hex");
      const id = addUploadedTrail(name, g.desc, g.lines, key);
      results.push({ file: f.originalname, id, name });
    } catch (e) {
      results.push({ file: f.originalname, error: e.message });
    }
  }
  res.json(results);
});

const PUBLIC_SETTINGS = ["wanderer_url", "auto_push", "sources", "min_length_m", "cache_days", "wanderer_user"];
app.get("/api/settings", (req, res) => {
  const s = getSettings();
  const out = Object.fromEntries(PUBLIC_SETTINGS.map((k) => [k, s[k]]));
  out.has_api_key = !!s.wanderer_api_key;
  out.has_password = !!s.wanderer_password;
  res.json(out);
});

app.post("/api/settings", (req, res) => {
  const b = req.body || {};
  const upd = {};
  for (const k of PUBLIC_SETTINGS) if (k in b) upd[k] = b[k];
  if (b.wanderer_api_key) upd.wanderer_api_key = b.wanderer_api_key;
  if (b.wanderer_password) upd.wanderer_password = b.wanderer_password;
  if (b.clear_api_key) upd.wanderer_api_key = "";
  setSettings(upd);
  kickPush();
  res.json({ ok: true });
});

app.post("/api/settings/test", async (req, res) => {
  try {
    await testConnection();
    kickPush();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/healthz", (req, res) => res.send("ok"));

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Trail Fetcher listening on :${PORT}`);
  kickJobs();
  kickPush();
});
