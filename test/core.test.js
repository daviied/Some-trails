import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleTrails, chainLines, tilesForBbox, parseBbox, normName } from "../src/geo.js";
import { buildGpx, parseGpx } from "../src/gpx.js";
import { parseOverpass } from "../src/sources/osm.js";

test("segments with same name join into one trail", () => {
  const segs = [
    { id: "a", name: "Ridge Trail", line: [[0, 0], [0.001, 0]] },
    { id: "b", name: "Ridge Trail", line: [[0.002, 0], [0.001, 0]] }, // reversed, touches a
    { id: "c", name: "Ridge Trail", line: [[1, 1], [1.001, 1]] },     // far away -> separate trail
    { id: "d", name: "Creek", line: [[0, 0], [0, 0.001]] },
    { id: "e", name: "", line: [[0, 0], [0, 0.001]] },                // unnamed -> dropped
  ];
  const t = assembleTrails(segs);
  assert.equal(t.length, 3);
  const ridge = t.find((x) => x.segIds.includes("a"));
  assert.deepEqual(ridge.segIds, ["a", "b"]);
  assert.equal(ridge.lines.length, 1);
  assert.equal(ridge.lines[0].length, 3);
});

test("chainLines keeps gaps as separate lines", () => {
  assert.equal(chainLines([[[0, 0], [0.001, 0]], [[0.5, 0], [0.501, 0]]]).length, 2);
});

test("tiles and bbox", () => {
  assert.equal(tilesForBbox({ minLon: -112.1, minLat: 33.3, maxLon: -111.9, maxLat: 33.6 }).length, 4);
  assert.equal(parseBbox("1,2,0,3"), null);
  assert.deepEqual(parseBbox("-1,2,0,3"), { minLon: -1, minLat: 2, maxLon: 0, maxLat: 3 });
  assert.equal(normName("Wonderland Trail"), normName("wonderland"));
});

test("gpx round trip", () => {
  const gpx = buildGpx({ name: "A & B <trail>", desc: "x", lines: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] });
  const g = parseGpx(gpx);
  assert.equal(g.name, "A & B <trail>");
  assert.equal(g.desc, "x");
  assert.deepEqual(g.lines, [[[1, 2], [3, 4]], [[5, 6], [7, 8]]]);
});

test("gpx route points parse", () => {
  const g = parseGpx(`<gpx><rte><name>R</name><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte></gpx>`);
  assert.deepEqual(g.lines, [[[2, 1], [4, 3]]]);
});

test("overpass response parse", () => {
  const data = { elements: [
    { type: "relation", id: 7, tags: { name: "Big Loop", route: "hiking" }, members: [
      { type: "way", geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }] },
      { type: "way", geometry: [{ lat: 0, lon: 0.001 }, { lat: 0, lon: 0.002 }] },
    ] },
    { type: "way", id: 1, tags: { name: "Big Loop", highway: "path" }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
    { type: "way", id: 2, tags: { name: "Side Path", highway: "path" }, geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
  ] };
  const r = parseOverpass(data);
  assert.equal(r.routes.length, 1);
  assert.equal(r.routes[0].key, "relation/7");
  assert.equal(r.routes[0].lines.length, 1);
  assert.deepEqual(r.segments.map((s) => s.id), ["way/2"]);
});

import { assembleUnnamed, PointIndex } from "../src/geo.js";

test("unnamed segments join only where there is no junction", () => {
  const t = assembleUnnamed([
    { id: "a", line: [[0, 0], [0.001, 0]] },
    { id: "b", line: [[0.001, 0], [0.002, 0]] },      // a-b chain (2 at point)
    { id: "c", line: [[0.002, 0], [0.002, 0.001]] },  // b, c, d meet -> junction
    { id: "d", line: [[0.002, 0], [0.003, 0]] },
  ]);
  const ab = t.find((x) => x.segIds.includes("a"));
  assert.deepEqual(ab.segIds, ["a", "b"]);
  assert.equal(t.length, 3);
});

test("overlap index finds a copy of a trail", () => {
  const idx = new PointIndex();
  idx.add([[[-121.7, 46.8], [-121.69, 46.8]]], 1);
  const same = idx.coverage([[[-121.69, 46.8001], [-121.7, 46.8001]]]); // reversed, 11 m away
  assert.ok(same.frac > 0.95);
  assert.equal(same.owner, 1);
  const other = idx.coverage([[[-121.7, 46.81], [-121.69, 46.81]]]); // 1.1 km away
  assert.equal(other.frac, 0);
});

test("pieces of one trail with a gap stay one trail", () => {
  const t = assembleTrails([
    { id: "a", name: "Divide Ridge", line: [[0, 0], [0.001, 0]] },
    { id: "b", name: "Divide Ridge", line: [[0.011, 0], [0.012, 0]] }, // 1.1 km gap
    { id: "c", name: "Divide Ridge", line: [[0.2, 0], [0.201, 0]] },   // 22 km away: other trail
  ]);
  assert.equal(t.length, 2);
  const ab = t.find((x) => x.segIds.includes("a"));
  assert.deepEqual(ab.segIds, ["a", "b"]);
  assert.equal(ab.lines.length, 2);
});
