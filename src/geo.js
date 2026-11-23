// Geometry helpers. Coordinates are [lon, lat] (GeoJSON order).

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLength(line) {
  let d = 0;
  for (let i = 1; i < line.length; i++) d += haversine(line[i - 1], line[i]);
  return d;
}

export function bboxOfLines(lines) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const l of lines)
    for (const [x, y] of l) {
      if (x < minLon) minLon = x;
      if (x > maxLon) maxLon = x;
      if (y < minLat) minLat = y;
      if (y > maxLat) maxLat = y;
    }
  return { minLon, minLat, maxLon, maxLat };
}

export function bboxIntersects(a, b) {
  return !(a.maxLon < b.minLon || a.minLon > b.maxLon || a.maxLat < b.minLat || a.minLat > b.maxLat);
}

export function parseBbox(str) {
  if (!str) return null;
  const p = String(str).split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = p;
  if (minLon >= maxLon || minLat >= maxLat) return null;
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) return null;
  return { minLon, minLat, maxLon, maxLat };
}

// Fixed grid of tiles. Each tile is fetched once per source, then served from cache.
export const TILE_DEG = 0.25;

export function tilesForBbox(b) {
  const tiles = [];
  const x0 = Math.floor(b.minLon / TILE_DEG), x1 = Math.ceil(b.maxLon / TILE_DEG) - 1;
  const y0 = Math.floor(b.minLat / TILE_DEG), y1 = Math.ceil(b.maxLat / TILE_DEG) - 1;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      tiles.push({
        key: `${x}:${y}`,
        minLon: x * TILE_DEG, minLat: y * TILE_DEG,
        maxLon: (x + 1) * TILE_DEG, maxLat: (y + 1) * TILE_DEG,
      });
  return tiles;
}

export function normName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b(trail|trailhead|path|tr|loop|route|#)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Group segments with the same name into connected trails, then chain each group
 * into as few continuous lines as possible.
 * segs: [{id, name, line:[[lon,lat],...], meta}]
 * returns: [{name, segIds:[...], lines:[[...]], meta}]
 */
export function assembleTrails(segs, joinMeters = 60) {
  const byName = new Map();
  for (const s of segs) {
    if (!s.line || s.line.length < 2) continue;
    const k = normName(s.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(s);
  }
  const out = [];
  for (const group of byName.values()) {
    // union-find on endpoint proximity
    const parent = group.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const ends = group.map((s) => [s.line[0], s.line[s.line.length - 1]]);
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        if (find(i) === find(j)) continue;
        const near = ends[i].some((a) => ends[j].some((b) => haversine(a, b) <= joinMeters));
        if (near) parent[find(i)] = find(j);
      }
    const comps = new Map();
    group.forEach((s, i) => {
      const r = find(i);
      if (!comps.has(r)) comps.set(r, []);
      comps.get(r).push(s);
    });
    for (const comp of comps.values()) {
      out.push({
        name: comp[0].name,
        segIds: comp.map((s) => s.id).sort(),
        lines: chainLines(comp.map((s) => s.line), joinMeters),
        meta: comp[0].meta || {},
      });
    }
  }
  return out;
}

export function chainLines(lines, joinMeters = 60) {
  const pool = lines.map((l) => l.slice());
  const result = [];
  while (pool.length) {
    // start from the line whose start is farthest from any other endpoint (a dangling end)
    let startIdx = 0;
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i][0];
      const connected = pool.some((o, j) => j !== i && (haversine(s, o[0]) <= joinMeters || haversine(s, o[o.length - 1]) <= joinMeters));
      if (!connected) { startIdx = i; break; }
      const e = pool[i][pool[i].length - 1];
      const connectedEnd = pool.some((o, j) => j !== i && (haversine(e, o[0]) <= joinMeters || haversine(e, o[o.length - 1]) <= joinMeters));
      if (!connectedEnd) { pool[i].reverse(); startIdx = i; break; }
    }
    let chain = pool.splice(startIdx, 1)[0];
    let grew = true;
    while (grew && pool.length) {
      grew = false;
      const end = chain[chain.length - 1];
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i];
        if (haversine(end, l[0]) <= joinMeters) { chain = chain.concat(l.slice(1)); }
        else if (haversine(end, l[l.length - 1]) <= joinMeters) { chain = chain.concat(l.slice().reverse().slice(1)); }
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    result.push(chain);
  }
  return result;
}

// Reduce point count (Douglas-Peucker on degrees, fine for small tolerances)
export function simplify(line, tol = 0.00002) {
  if (line.length < 3) return line;
  const sq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const segDist = (p, a, b) => {
    let x = a[0], y = a[1];
    let dx = b[0] - x, dy = b[1] - y;
    if (dx || dy) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    return sq(p, [x, y]);
  };
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [f, l] = stack.pop();
    let maxD = 0, idx = 0;
    for (let i = f + 1; i < l; i++) {
      const d = segDist(line[i], line[f], line[l]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > t2) { keep[idx] = 1; stack.push([f, idx], [idx, l]); }
  }
  return line.filter((_, i) => keep[i]);
}
