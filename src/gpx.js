// GPX build and parse (no dependencies).

const esc = (s) =>
  String(s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

export function buildGpx({ name, desc, lines }) {
  const segs = lines
    .map((l) => `<trkseg>${l.map(([lon, lat]) => `<trkpt lat="${lat}" lon="${lon}"/>`).join("")}</trkseg>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="trail-fetcher" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(name)}</name>${desc ? `<desc>${esc(desc)}</desc>` : ""}</metadata>
<trk><name>${esc(name)}</name>
${segs}
</trk>
</gpx>`;
}

const attr = (tag, a) => {
  const m = tag.match(new RegExp(`\\b${a}\\s*=\\s*["']([^"']+)["']`));
  return m ? parseFloat(m[1]) : NaN;
};
const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const textOf = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`));
  return m ? unesc(m[1].trim()) : "";
};

// Returns {name, desc, lines}
export function parseGpx(xml) {
  const lines = [];
  const pick = (blockRe, ptRe) => {
    for (const block of xml.match(blockRe) || []) {
      const pts = [];
      for (const tag of block.match(ptRe) || []) {
        const lat = attr(tag, "lat"), lon = attr(tag, "lon");
        if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lon, lat]);
      }
      if (pts.length > 1) lines.push(pts);
    }
  };
  pick(/<trkseg[\s\S]*?<\/trkseg>/g, /<trkpt\b[^>]*>/g);
  if (!lines.length) pick(/<rte\b[\s\S]*?<\/rte>/g, /<rtept\b[^>]*>/g);
  const meta = (xml.match(/<metadata[\s\S]*?<\/metadata>/) || [""])[0];
  const trk = (xml.match(/<trk\b[\s\S]*?<\/trk>/) || [""])[0];
  return {
    name: textOf(meta, "name") || textOf(trk.replace(/<trkseg[\s\S]*/, ""), "name"),
    desc: textOf(meta, "desc") || textOf(trk.replace(/<trkseg[\s\S]*/, ""), "desc"),
    lines,
  };
}
