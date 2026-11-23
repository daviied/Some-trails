// Fetch jobs (internet -> local cache) and the push queue (local cache -> Wanderer).
import { db, getSettings, now } from "./db.js";
import { tilesForBbox, assembleTrails, bboxOfLines, bboxIntersects, lineLength, normName, simplify } from "./geo.js";
import { fetchUsgsTile } from "./sources/usgs.js";
import { fetchOsmTile } from "./sources/osm.js";
import { buildGpx } from "./gpx.js";
import { uploadGpx, wandererConfigured } from "./wanderer.js";
import { sleep, withTimeout } from "./http.js";

export const state = { jobRunning: false, pushRunning: false, pushPaused: "", currentJob: null, lastPushError: "" };

const SOURCES = {
  usgs: { label: "USGS", fetch: fetchUsgsTile, delay: 300 },
  osm: { label: "OpenStreetMap", fetch: fetchOsmTile, delay: 1500 },
};

export const MAX_TILES = Number(process.env.MAX_JOB_TILES || 6000);

// ---------- statements ----------
const q = {
  tileGet: db.prepare("SELECT fetched_at FROM tiles WHERE source=? AND key=?"),
  tilePut: db.prepare("INSERT INTO tiles(source,key,fetched_at,count) VALUES(?,?,?,?) ON CONFLICT(source,key) DO UPDATE SET fetched_at=excluded.fetched_at, count=excluded.count"),
  segPut: db.prepare(`INSERT INTO segments(source,seg_id,name,line,min_lon,min_lat,max_lon,max_lat,meta) VALUES(@source,@seg_id,@name,@line,@min_lon,@min_lat,@max_lon,@max_lat,@meta)
    ON CONFLICT(source,seg_id) DO UPDATE SET name=excluded.name, line=excluded.line, min_lon=excluded.min_lon, min_lat=excluded.min_lat, max_lon=excluded.max_lon, max_lat=excluded.max_lat, meta=excluded.meta`),
  segsIn: db.prepare("SELECT * FROM segments WHERE source=? AND max_lon>=? AND min_lon<=? AND max_lat>=? AND min_lat<=?"),
  trailByKey: db.prepare("SELECT * FROM trails WHERE source=? AND source_key=?"),
  trailsIn: db.prepare("SELECT * FROM trails WHERE max_lon>=? AND min_lon<=? AND max_lat>=? AND min_lat<=?"),
  trailIns: db.prepare(`INSERT INTO trails(source,source_key,name,lines,length_m,min_lon,min_lat,max_lon,max_lat,meta,fetched_at,push_status)
    VALUES(@source,@source_key,@name,@lines,@length_m,@min_lon,@min_lat,@max_lon,@max_lat,@meta,@fetched_at,@push_status)`),
  trailUpd: db.prepare(`UPDATE trails SET name=@name, lines=@lines, length_m=@length_m, min_lon=@min_lon, min_lat=@min_lat, max_lon=@max_lon, max_lat=@max_lat, meta=@meta, fetched_at=@fetched_at WHERE id=@id`),
  jobNext: db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY (label='Browse') DESC, id LIMIT 1"),
  browseNext: db.prepare("SELECT * FROM jobs WHERE status='queued' AND label='Browse' ORDER BY id DESC LIMIT 1"),
  jobUpd: db.prepare("UPDATE jobs SET status=@status, total=@total, done=@done, found=@found, message=@message, updated_at=@updated_at WHERE id=@id"),
  pushNext: db.prepare("SELECT * FROM trails WHERE push_status='queued' ORDER BY id LIMIT 1"),
  pushSet: db.prepare("UPDATE trails SET push_status=?, push_error=?, wanderer_id=?, pushed_at=? WHERE id=?"),
};

// ---------- jobs ----------
export function createJob(bbox, label, push = true) {
  const tiles = tilesForBbox(bbox);
  if (tiles.length > MAX_TILES) throw new Error(`Area too large (${tiles.length} tiles, limit ${MAX_TILES}). Make the box smaller.`);
  // only the newest browse request matters; drop older ones that have not started
  if (label === "Browse") db.prepare("UPDATE jobs SET status='cancelled', message='Replaced by newer browse' WHERE status='queued' AND label='Browse'").run();
  const r = db.prepare("INSERT INTO jobs(label,bbox,push,status,total,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
    .run(label || "Area", JSON.stringify(bbox), push ? 1 : 0, "queued", tiles.length, now(), now());
  kickJobs();
  return r.lastInsertRowid;
}

export function tileCoverage(bbox) {
  const s = getSettings();
  const ttl = Number(s.cache_days) * 864e5;
  const sources = activeSources();
  const tiles = tilesForBbox(bbox);
  let cached = 0;
  for (const t of tiles) {
    if (sources.every((src) => { const r = q.tileGet.get(src, t.key); return r && now() - r.fetched_at < ttl; })) cached++;
  }
  return { tiles: tiles.length, cached };
}

const activeSources = () => getSettings().sources.split(",").map((s) => s.trim()).filter((s) => SOURCES[s]);

export function kickJobs() {
  if (state.jobRunning) return;
  state.jobRunning = true;
  (async () => {
    try {
      let job;
      while ((job = q.jobNext.get())) await safeRun(job);
    } finally {
      state.jobRunning = false;
      state.currentJob = null;
    }
  })();
}

const TILE_TIMEOUT_MS = Number(process.env.TILE_TIMEOUT_MS || 6 * 60e3);

async function safeRun(job) {
  try {
    await runJob(job);
  } catch (e) {
    console.error(`[job ${job.id}] failed:`, e);
    db.prepare("UPDATE jobs SET status='error', message=?, updated_at=? WHERE id=?").run(String(e.message || e).slice(0, 500), now(), job.id);
  }
}

const BLOCK_DEG = 1; // tiles are grouped in 1° blocks; each block is built and pushed when done

function blocksOf(tiles) {
  const m = new Map();
  for (const t of tiles) {
    const k = `${Math.floor(t.minLon / BLOCK_DEG)}:${Math.floor(t.minLat / BLOCK_DEG)}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return [...m.values()].map((ts) => ({
    tiles: ts,
    bbox: {
      minLon: Math.min(...ts.map((t) => t.minLon)), minLat: Math.min(...ts.map((t) => t.minLat)),
      maxLon: Math.max(...ts.map((t) => t.maxLon)), maxLat: Math.max(...ts.map((t) => t.maxLat)),
    },
  }));
}

async function runJob(job) {
  const bbox = JSON.parse(job.bbox);
  const s = getSettings();
  const ttl = Number(s.cache_days) * 864e5;
  const sources = activeSources();
  const tiles = tilesForBbox(bbox);
  const blocks = blocksOf(tiles);
  const queue = job.push && s.auto_push === "true";
  const j = { id: job.id, status: "running", total: tiles.length * sources.length, done: 0, found: 0, message: "", updated_at: now() };
  state.currentJob = j;
  const save = () => { j.updated_at = now(); q.jobUpd.run(j); };
  save();
  const errors = [];
  const fresh = (src, t) => { const c = q.tileGet.get(src, t.key); return c && now() - c.fetched_at < ttl; };
  const fail = (src, ts, e) => {
    errors.push(`${src}: ${e.message}`);
    // remember the failure for 1 hour so browsing does not retry it on every map move
    for (const t of ts) q.tilePut.run(src, t.key, now() - ttl + 3600e3, -1);
    console.warn(`[job ${job.id}] ${src} failed:`, e.message);
  };

  // One source for one block. USGS: one request for the block. OSM: tile by tile (Overpass load).
  async function fetchBlock(src, blk) {
    const todo = blk.tiles.filter((t) => !fresh(src, t));
    j.done += blk.tiles.length - todo.length;
    if (!todo.length) return;
    if (src === "usgs") {
      const bb = {
        minLon: Math.min(...todo.map((t) => t.minLon)), minLat: Math.min(...todo.map((t) => t.minLat)),
        maxLon: Math.max(...todo.map((t) => t.maxLon)), maxLat: Math.max(...todo.map((t) => t.maxLat)),
      };
      try {
        const res = await withTimeout(SOURCES[src].fetch(bb), TILE_TIMEOUT_MS * 2, "USGS block took too long");
        storeTiles(src, todo, res);
      } catch (e) { fail(src, todo, e); }
      j.done += todo.length;
      save();
      return;
    }
    for (const t of todo) {
      if (jobCancelled(job.id)) return;
      try {
        const res = await withTimeout(SOURCES[src].fetch(t), TILE_TIMEOUT_MS, `tile took longer than ${TILE_TIMEOUT_MS / 60e3} min`);
        storeTiles(src, [t], res);
      } catch (e) { fail(src, [t], e); }
      j.done++;
      save();
      await sleep(SOURCES[src].delay);
    }
  }

  for (let bi = 0; bi < blocks.length; bi++) {
    if (jobCancelled(job.id)) return;
    // a big area import lets browse requests go first
    if (job.label !== "Browse") {
      let b;
      while ((b = q.browseNext.get())) { await safeRun(b); state.currentJob = j; }
    }
    const blk = blocks[bi];
    j.message = `Block ${bi + 1}/${blocks.length}: downloading`;
    save();
    await Promise.all(sources.map((src) => fetchBlock(src, blk)));
    if (jobCancelled(job.id)) return;
    // build and push this block now, so trails reach Wanderer while the job runs
    const area = {
      minLon: Math.max(blk.bbox.minLon, bbox.minLon), minLat: Math.max(blk.bbox.minLat, bbox.minLat),
      maxLon: Math.min(blk.bbox.maxLon, bbox.maxLon), maxLat: Math.min(blk.bbox.maxLat, bbox.maxLat),
    };
    j.found += buildTrails(area, sources, queue);
    save();
    kickPush();
  }

  j.status = errors.length && errors.length >= j.total ? "error" : "done";
  j.message = errors.length ? `${errors.length} request(s) failed. Run again to retry. First: ${errors[0]}` : "";
  save();
  kickPush();
}

function jobCancelled(id) {
  const r = db.prepare("SELECT status FROM jobs WHERE id=?").get(id);
  return !r || r.status === "cancelled";
}

const storeTiles = db.transaction((src, tiles, res) => {
  const segs = Array.isArray(res) ? res : res.segments;
  for (const sg of segs) {
    const b = bboxOfLines([sg.line]);
    q.segPut.run({
      source: src, seg_id: sg.id, name: sg.name || "", line: JSON.stringify(sg.line),
      min_lon: b.minLon, min_lat: b.minLat, max_lon: b.maxLon, max_lat: b.maxLat,
      meta: JSON.stringify(sg.meta || {}),
    });
  }
  const routes = Array.isArray(res) ? [] : res.routes || [];
  const autoQ = getSettings().auto_push === "true";
  for (const r of routes) upsertTrail(src, r.key, r.name, r.lines, r.meta, autoQ ? "queued" : "new");
  for (const t of tiles) q.tilePut.run(src, t.key, now(), segs.length + routes.length);
});

function upsertTrail(source, key, name, lines, meta, status) {
  lines = lines.map((l) => simplify(l)).filter((l) => l.length > 1);
  if (!lines.length) return null;
  const b = bboxOfLines(lines);
  const row = {
    source, source_key: key, name, lines: JSON.stringify(lines),
    length_m: Math.round(lines.reduce((a, l) => a + lineLength(l), 0)),
    min_lon: b.minLon, min_lat: b.minLat, max_lon: b.maxLon, max_lat: b.maxLat,
    meta: JSON.stringify(meta || {}), fetched_at: now(), push_status: status,
  };
  let existing = q.trailByKey.get(source, key);
  if (!existing) {
    // same trail found earlier with a different key (it grew across tiles)
    const nn = normName(name);
    existing = q.trailsIn.all(b.minLon, b.maxLon, b.minLat, b.maxLat)
      .find((t) => t.source === source && normName(t.name) === nn);
  }
  if (existing) {
    // keep the longer geometry
    if (row.length_m >= (existing.length_m || 0)) q.trailUpd.run({ ...row, id: existing.id });
    return existing.id;
  }
  return q.trailIns.run(row).lastInsertRowid;
}

// Assemble stored segments into trails for an area, then mark OSM copies of USGS trails.
function buildTrails(bbox, sources, queue) {
  const s = getSettings();
  const minLen = Number(s.min_length_m) || 0;
  const pad = 0.05;
  let count = 0;
  const tx = db.transaction(() => {
    for (const src of sources) {
      const segs = q.segsIn.all(src, bbox.minLon - pad, bbox.maxLon + pad, bbox.minLat - pad, bbox.maxLat + pad)
        .map((r) => ({ id: r.seg_id, name: r.name, line: JSON.parse(r.line), meta: JSON.parse(r.meta || "{}") }));
      for (const t of assembleTrails(segs)) {
        const len = t.lines.reduce((a, l) => a + lineLength(l), 0);
        if (len < minLen) continue;
        const b = bboxOfLines(t.lines);
        if (!bboxIntersects(b, bbox)) continue;
        upsertTrail(src, `${normName(t.name)}|${t.segIds[0]}`, t.name, t.lines, { ...t.meta, segments: t.segIds.length }, queue ? "queued" : "new");
        count++;
      }
    }
    // USGS wins. Skip OSM/other trails with the same name in the same place.
    const rows = q.trailsIn.all(bbox.minLon - pad, bbox.maxLon + pad, bbox.minLat - pad, bbox.maxLat + pad);
    const usgs = rows.filter((r) => r.source === "usgs");
    for (const r of rows) {
      if (r.source !== "osm" || ["pushed", "duplicate", "skipped"].includes(r.push_status)) continue;
      const nn = normName(r.name);
      const twin = usgs.find((u) => normName(u.name) === nn && bboxIntersects(rowBox(u), rowBox(r)));
      if (twin) q.pushSet.run("skipped", `Same as USGS trail #${twin.id}`, null, null, r.id);
    }
  });
  tx();
  return count;
}

function rowBox(r) { return { minLon: r.min_lon, maxLon: r.max_lon, minLat: r.min_lat, maxLat: r.max_lat }; }

// ---------- push queue ----------
export function kickPush() {
  if (state.pushRunning || !wandererConfigured()) return;
  state.pushRunning = true;
  state.pushPaused = "";
  (async () => {
    try {
      let t;
      while ((t = q.pushNext.get())) {
        try {
          const lines = JSON.parse(t.lines);
          const meta = JSON.parse(t.meta || "{}");
          const gpx = buildGpx({ name: t.name, desc: describe(t, meta), lines });
          const r = await uploadGpx(gpx, t.name);
          q.pushSet.run(r.status, null, r.id || null, now(), t.id);
          state.lastPushError = "";
        } catch (e) {
          state.lastPushError = e.message;
          if (e.fatal) { state.pushPaused = e.message; break; }
          if (e.retry) { await sleep(15000); continue; }
          q.pushSet.run("error", e.message.slice(0, 500), null, null, t.id);
        }
        await sleep(Number(process.env.PUSH_DELAY_MS || 200));
      }
    } finally {
      state.pushRunning = false;
    }
  })();
}

function describe(t, meta) {
  const src = { usgs: "USGS National Digital Trails", osm: "OpenStreetMap contributors (ODbL)", upload: "GPX upload" }[t.source] || t.source;
  const parts = [];
  if (meta.description) parts.push(meta.description);
  if (meta.trailnumber) parts.push(`Trail number: ${meta.trailnumber}`);
  if (meta.surface) parts.push(`Surface: ${meta.surface}`);
  if (meta.maintainer) parts.push(`Maintainer: ${meta.maintainer}`);
  if (meta.operator) parts.push(`Operator: ${meta.operator}`);
  if (meta.national) parts.push(`Designation: ${meta.national}`);
  if (meta.osm) parts.push(meta.osm);
  parts.push(`Source: ${src}`);
  return parts.join("\n");
}

export function addUploadedTrail(name, desc, lines, key) {
  const autoQ = getSettings().auto_push === "true";
  const id = upsertTrail("upload", key, name || "Uploaded trail", lines, { description: desc }, autoQ ? "queued" : "new");
  kickPush();
  return id;
}
