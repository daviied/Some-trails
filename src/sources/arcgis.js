// Generic reader for ArcGIS REST trail layers (USGS, NPS, USFS). US only.
import { fetchRetry } from "../http.js";

const round = (n) => Math.round(n * 1e6) / 1e6;
// "PCT: MBS WHITE RIVER" -> "PCT: Mbs White River" (USFS names are all caps)
const tidy = (n) => (n && n === n.toUpperCase() && /[A-Z]{3}/.test(n))
  ? n.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bPct\b/g, "PCT")
  : n;
const no = (v) => typeof v === "string" && /^(n|no|closed)$/i.test(v.trim());

export const LAYERS = {
  usgs: {
    label: "USGS National Digital Trails",
    url: process.env.USGS_TRAILS_URL || "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query",
    fields: "permanentidentifier,objectid,name,namealternate,trailnumber,trailtype,hikerpedestrian,bicycle,packsaddle,trailsurface,primarytrailmaintainer,nationaltraildesignation,sourceoriginator",
    where: "1=1",
    page: 1000,
    map: (p) => no(p.hikerpedestrian) ? null : {
      id: p.permanentidentifier || p.objectid,
      name: p.name || p.namealternate || (p.trailnumber ? `Trail ${p.trailnumber}` : ""),
      meta: {
        trailnumber: p.trailnumber, type: p.trailtype, surface: p.trailsurface, maintainer: p.primarytrailmaintainer,
        national: p.nationaltraildesignation, bicycle: p.bicycle, horse: p.packsaddle, origin: p.sourceoriginator,
      },
    },
  },
  nps: {
    label: "National Park Service",
    url: process.env.NPS_TRAILS_URL || "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails_Geographic/FeatureServer/0/query",
    fields: "OBJECTID,GEOMETRYID,FEATUREID,TRLNAME,TRLALTNAME,MAPLABEL,TRLSTATUS,TRLSURFACE,TRLTYPE,TRLCLASS,TRLUSE,UNITNAME,OPENTOPUBLIC,SEASONAL,SEASDESC,MAINTAINER",
    where: "1=1",
    page: 1000,
    map: (p) => (no(p.OPENTOPUBLIC) || /closed|decommission/i.test(p.TRLSTATUS || "")) ? null : {
      id: p.GEOMETRYID || p.FEATUREID || p.OBJECTID,
      name: p.TRLNAME || p.MAPLABEL || p.TRLALTNAME || "",
      meta: {
        park: p.UNITNAME, type: p.TRLTYPE, class: p.TRLCLASS, use: p.TRLUSE, surface: p.TRLSURFACE,
        seasonal: p.SEASONAL === "Yes" ? p.SEASDESC || "Yes" : undefined, maintainer: p.MAINTAINER,
      },
    },
  },
  usfs: {
    label: "US Forest Service",
    url: process.env.USFS_TRAILS_URL || "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query",
    fields: "objectid,trail_cn,trail_name,trail_no,trail_type,trail_class,trail_surface,managing_org,national_trail_designation,allowed_terra_use,special_mgmt_area,bmp,emp",
    where: "trail_type='TERRA'",
    page: 1000,
    map: (p) => ({
      id: `${p.trail_cn || p.objectid}-${p.bmp ?? ""}`,
      name: p.trail_name || (p.trail_no ? `Trail ${p.trail_no}` : ""),
      meta: {
        trailnumber: p.trail_no, class: p.trail_class, surface: p.trail_surface, maintainer: p.managing_org,
        national: p.national_trail_designation, area: p.special_mgmt_area,
      },
    }),
  },
};

// Returns segments: [{id, name, line, meta}]
export async function fetchArcgis(layerKey, bbox) {
  const L = LAYERS[layerKey];
  const segs = [];
  for (let offset = 0; ; offset += L.page) {
    const params = new URLSearchParams({
      where: L.where,
      geometry: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: L.fields,
      returnGeometry: "true",
      resultOffset: String(offset),
      resultRecordCount: String(L.page),
      orderByFields: L.fields.split(",").find((f) => /^objectid$/i.test(f)) || "",
      f: "geojson",
    });
    const res = await fetchRetry(`${L.url}?${params}`);
    if (!res.ok) throw new Error(`${L.label} HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`${L.label}: ${data.error.message || "query failed"}`);
    const feats = data.features || [];
    for (const f of feats) {
      const m = L.map(f.properties || {});
      const g = f.geometry;
      if (!m || !g) continue;
      const lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
      const meta = Object.fromEntries(Object.entries(m.meta).filter(([, v]) => v != null && v !== ""));
      lines.forEach((line, i) => {
        if (line.length < 2) return;
        segs.push({
          id: `${m.id}${lines.length > 1 ? "-" + i : ""}`,
          name: tidy(m.name),
          line: line.map((c) => [round(c[0]), round(c[1])]),
          meta,
        });
      });
    }
    if (feats.length === 0) break;
    if (feats.length < L.page && !data.exceededTransferLimit && !data.properties?.exceededTransferLimit) break;
  }
  return segs;
}
