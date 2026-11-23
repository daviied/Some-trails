// USGS National Map "Trails" layer (National Digital Trails dataset). US only.
import { fetchRetry } from "../http.js";

const URL_BASE =
  process.env.USGS_TRAILS_URL ||
  "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query";

const FIELDS = [
  "permanentidentifier", "objectid", "name", "namealternate", "trailnumber", "trailtype",
  "hikerpedestrian", "bicycle", "packsaddle", "trailsurface", "primarytrailmaintainer",
  "nationaltraildesignation", "lengthmiles", "sourceoriginator",
].join(",");

// Returns segments: [{id, name, line, meta}]
export async function fetchUsgsTile(tile) {
  const segs = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const params = new URLSearchParams({
      geometry: `${tile.minLon},${tile.minLat},${tile.maxLon},${tile.maxLat}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: FIELDS,
      returnGeometry: "true",
      resultOffset: String(offset),
      resultRecordCount: String(page),
      orderByFields: "objectid",
      f: "geojson",
    });
    const res = await fetchRetry(`${URL_BASE}?${params}`);
    if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`USGS: ${data.error.message || "query failed"}`);
    const feats = data.features || [];
    for (const f of feats) {
      const p = f.properties || {};
      if (p.hikerpedestrian && /^n/i.test(p.hikerpedestrian)) continue; // closed to hikers
      const g = f.geometry;
      if (!g) continue;
      const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      lines.forEach((line, i) => {
        segs.push({
          id: `${p.permanentidentifier || p.objectid}${lines.length > 1 ? "-" + i : ""}`,
          name: p.name || p.namealternate || (p.trailnumber ? `Trail ${p.trailnumber}` : ""),
          line: line.map((c) => [round(c[0]), round(c[1])]),
          meta: {
            trailnumber: p.trailnumber || undefined,
            type: p.trailtype || undefined,
            surface: p.trailsurface || undefined,
            maintainer: p.primarytrailmaintainer || undefined,
            national: p.nationaltraildesignation || undefined,
            bicycle: p.bicycle || undefined,
            horse: p.packsaddle || undefined,
            origin: p.sourceoriginator || undefined,
          },
        });
      });
    }
    if (feats.length < page && !data.exceededTransferLimit && !data.properties?.exceededTransferLimit) break;
    if (feats.length === 0) break;
  }
  return segs;
}

const round = (n) => Math.round(n * 1e6) / 1e6;
