import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "trails.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS segments (
  source TEXT NOT NULL,
  seg_id TEXT NOT NULL,
  name TEXT,
  line TEXT NOT NULL,
  min_lon REAL, min_lat REAL, max_lon REAL, max_lat REAL,
  meta TEXT,
  PRIMARY KEY (source, seg_id)
);
CREATE INDEX IF NOT EXISTS seg_bbox ON segments(min_lon, max_lon, min_lat, max_lat);

CREATE TABLE IF NOT EXISTS trails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  name TEXT NOT NULL,
  lines TEXT NOT NULL,
  length_m REAL,
  min_lon REAL, min_lat REAL, max_lon REAL, max_lat REAL,
  meta TEXT,
  fetched_at INTEGER,
  push_status TEXT DEFAULT 'pending',
  push_error TEXT,
  wanderer_id TEXT,
  pushed_at INTEGER,
  UNIQUE(source, source_key)
);
CREATE INDEX IF NOT EXISTS trail_bbox ON trails(min_lon, max_lon, min_lat, max_lat);
CREATE INDEX IF NOT EXISTS trail_status ON trails(push_status);

CREATE TABLE IF NOT EXISTS tiles (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  count INTEGER,
  PRIMARY KEY (source, key)
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  bbox TEXT NOT NULL,
  push INTEGER DEFAULT 1,
  status TEXT DEFAULT 'queued',
  total INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  found INTEGER DEFAULT 0,
  message TEXT,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Jobs that were running when the server stopped start again.
db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run();

const DEFAULTS = {
  wanderer_url: process.env.WANDERER_URL || "",
  wanderer_api_key: process.env.WANDERER_API_KEY || "",
  wanderer_user: process.env.WANDERER_USER || "",
  wanderer_password: process.env.WANDERER_PASSWORD || "",
  auto_push: process.env.AUTO_PUSH ?? "true",
  sources: process.env.SOURCES || "usgs,nps,usfs,osm",
  include_unnamed: "false",
  min_length_m: process.env.MIN_LENGTH_M || "400",
  cache_days: process.env.CACHE_DAYS || "90",
};

// v2 added NPS and USFS. Old saved default "usgs,osm" gets the new sources.
if (!db.prepare("SELECT 1 FROM settings WHERE key='sources_v2'").get()) {
  db.prepare("UPDATE settings SET value='usgs,nps,usfs,osm' WHERE key='sources' AND value='usgs,osm'").run();
  db.prepare("INSERT INTO settings(key,value) VALUES('sources_v2','1')").run();
}

export function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const s = { ...DEFAULTS };
  for (const r of rows) if (r.key in DEFAULTS && r.value !== null && r.value !== "") s[r.key] = r.value;
  // env SOURCES from an older compose file ("usgs,osm") also gets the new sources
  if (!rows.some((r) => r.key === "sources") && /^usgs,osm$/.test(s.sources)) s.sources = "usgs,nps,usfs,osm";
  return s;
}

export function setSettings(obj) {
  const st = db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const tx = db.transaction((o) => {
    for (const [k, v] of Object.entries(o)) if (k in DEFAULTS) st.run(k, v == null ? "" : String(v));
  });
  tx(obj);
}

export const now = () => Date.now();
