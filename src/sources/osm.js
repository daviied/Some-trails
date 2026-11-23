// OpenStreetMap through the Overpass API. Worldwide.
import { fetchRetry, sleep } from "../http.js";
import { chainLines } from "../geo.js";

const MIRRORS = (process.env.OVERPASS_URLS ||
  "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter,https://overpass.kumi.systems/api/interpreter")
  .split(",").map((s) => s.trim()).filter(Boolean);

let mirrorIdx = 0;

async function overpass(query) {
  let lastErr;
  for (let n = 0; n < MIRRORS.length; n++) {
    const url = MIRRORS[(mirrorIdx + n) % MIRRORS.length];
    try {
      const res = await fetchRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      }, { tries: 2, timeout: 180000 });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      const json = await res.json();
      mirrorIdx = (mirrorIdx + n) % MIRRORS.length;
      return json;
    } catch (e) {
      lastErr = e;
      await sleep(1000);
    }
  }
  throw lastErr;
}

/**
 * Returns { routes, segments }
 *  routes: complete hiking route relations [{key, name, lines, meta}]
 *  segments: named footpaths [{id, name, line, meta}] that are assembled later
 */
export async function fetchOsmTile(tile) {
  const bb = `${tile.minLat},${tile.minLon},${tile.maxLat},${tile.maxLon}`;
  const q = `[out:json][timeout:170];
(
  relation["type"="route"]["route"~"^(hiking|foot|walking)$"](${bb});
  way["highway"~"^(path|footway|bridleway|steps)$"]["name"]["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"](${bb});
  way["highway"="track"]["name"~"[Tt]rail"](${bb});
);
out geom;`;
  return parseOverpass(await overpass(q));
}

export function parseOverpass(data) {
  const routes = [];
  const segments = [];
  const routeNames = new Set();
  for (const el of data.elements || []) {
    if (el.type === "relation") {
      const t = el.tags || {};
      const name = t.name || t.ref || "";
      if (!name) continue;
      const lines = (el.members || [])
        .filter((m) => m.type === "way" && Array.isArray(m.geometry) && m.geometry.length > 1)
        .map((m) => m.geometry.map((p) => [p.lon, p.lat]));
      if (!lines.length) continue;
      routeNames.add(name.toLowerCase());
      routes.push({
        key: `relation/${el.id}`,
        name,
        lines: chainLines(lines),
        meta: {
          osm: `https://www.openstreetmap.org/relation/${el.id}`,
          network: t.network, operator: t.operator, ref: t.ref,
          description: t.description, distance: t.distance, website: t.website,
        },
      });
    } else if (el.type === "way" && Array.isArray(el.geometry)) {
      const t = el.tags || {};
      segments.push({
        id: `way/${el.id}`,
        name: t.name,
        line: el.geometry.map((p) => [p.lon, p.lat]),
        meta: { surface: t.surface, sac_scale: t.sac_scale, highway: t.highway, operator: t.operator },
      });
    }
  }
  // ways that belong to a named route relation are already covered by that route
  return { routes, segments: segments.filter((s) => !routeNames.has(String(s.name).toLowerCase())) };
}
