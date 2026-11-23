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
 * Group segments with the same name that are near each other into one trail, then chain each group
 * into as few continuous lines as possible.
 * segs: [{id, name, line:[[lon,lat],...], meta}]
 * returns: [{name, segIds:[...], lines:[[...]], meta}]
 */
export function assembleTrails(segs, joinMeters = 60, groupMeters = Number(process.env.TRAIL_GROUP_M || 8000)) {
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
        // pieces of one trail with gaps (up to groupMeters) stay one trail with several parts
        const near = ends[i].some((a) => ends[j].some((b) => haversine(a, b) <= groupMeters));
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

/**
 * Join unnamed segments into trails. Two segments join only where they meet end to end
 * and no third segment touches that point (no junction), so path networks do not become one trail.
 */
export function assembleUnnamed(segs) {
  const list = segs.filter((s) => s.line && s.line.length > 1);
  const key = (p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  const at = new Map();
  list.forEach((s, i) => {
    for (const p of [s.line[0], s.line[s.line.length - 1]]) {
      const k = key(p);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(i);
    }
  });
  const parent = list.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const ids of at.values()) if (ids.length === 2 && ids[0] !== ids[1]) parent[find(ids[0])] = find(ids[1]);
  const comps = new Map();
  list.forEach((s, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(s);
  });
  return [...comps.values()].map((c) => ({
    segIds: c.map((s) => s.id).sort(),
    lines: chainLines(c.map((s) => s.line), 2),
    meta: c[0].meta || {},
  }));
}

// Points every `step` meters along a line (vertices included).
export function densify(line, step = 20) {
  const out = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i];
    const d = haversine(a, b);
    const n = Math.floor(d / step);
    for (let k = 1; k <= n; k++) {
      const t = (k * step) / d;
      if (t < 1) out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out.push(b);
  }
  return out;
}

/** Grid index of points along trails. Answers: how much of this trail lies on trails already kept? */
export class PointIndex {
  constructor(cell = 0.0006) { this.cell = cell; this.m = new Map(); }
  _k(x, y) { return `${Math.floor(x / this.cell)}:${Math.floor(y / this.cell)}`; }
  add(lines, owner) {
    for (const l of lines)
      for (const p of densify(l, 20)) {
        const k = this._k(p[0], p[1]);
        if (!this.m.has(k)) this.m.set(k, []);
        this.m.get(k).push([p[0], p[1], owner]);
      }
  }
  // returns {frac: 0..1 of the trail within tol meters of kept trails, owner: most common kept trail}
  coverage(lines, tol = 30) {
    let total = 0, hit = 0;
    const owners = new Map();
    for (const l of lines)
      for (const p of densify(l, 40)) {
        total++;
        const cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell);
        let found = null;
        for (let dx = -1; dx <= 1 && !found; dx++)
          for (let dy = -1; dy <= 1 && !found; dy++)
            for (const q of this.m.get(`${cx + dx}:${cy + dy}`) || [])
              if (haversine(p, q) <= tol) { found = q; break; }
        if (found) { hit++; owners.set(found[2], (owners.get(found[2]) || 0) + 1); }
      }
    let owner = null, best = 0;
    for (const [o, n] of owners) if (n > best) { best = n; owner = o; }
    return { frac: total ? hit / total : 0, owner };
  }
}
