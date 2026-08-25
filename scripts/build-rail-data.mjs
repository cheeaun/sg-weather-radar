// Builds public/rail.json from data/sg-rail.geojson (cheeaun/sgraildata v1),
// keeping only rail lines and stations. Coordinates are delta-encoded integers
// at 1e-5 degrees (~1.1 m), simplified with Douglas-Peucker (~2 m tolerance).
import { readFileSync, writeFileSync } from 'fs';

const SRC = new URL('../data/sg-rail.geojson', import.meta.url);
const OUT = new URL('../rail.json', import.meta.url);
const SCALE = 1e5;
const SIMPLIFY_EPSILON = 2; // int units, ~2.2 m

const geo = JSON.parse(readFileSync(SRC, 'utf8'));

function simplify(points, eps) {
  if (points.length < 3) return points;
  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  let mi = 0;
  let md = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const dist = Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / len;
    if (dist > md) {
      md = dist;
      mi = i;
    }
  }
  if (md > eps) {
    const left = simplify(points.slice(0, mi + 1), eps);
    const right = simplify(points.slice(mi), eps);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

function encodeSeg(coords) {
  // Round to int grid, simplify, then delta-encode; first pair is absolute.
  const pts = coords.map(([lon, lat]) => [
    Math.round(lon * SCALE),
    Math.round(lat * SCALE),
  ]);
  const simp = simplify(pts, SIMPLIFY_EPSILON);
  const out = [];
  for (let i = 0; i < simp.length; i++) {
    out.push(i === 0 ? simp[i][0] : simp[i][0] - simp[i - 1][0]);
    out.push(i === 0 ? simp[i][1] : simp[i][1] - simp[i - 1][1]);
  }
  return out;
}

const lines = [];
for (const f of geo.features) {
  const t = f.geometry.type;
  if (t !== 'LineString' && t !== 'MultiLineString') continue;
  if (!f.properties.line_color) continue;
  const segs = t === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
  lines.push([f.properties.name || '', f.properties.line_color, segs.map(encodeSeg)]);
}

const stations = [];
let sx = 0;
let sy = 0;
for (const f of geo.features) {
  if (f.geometry.type !== 'Point' || f.properties.stop_type !== 'station') continue;
  const x = Math.round(f.geometry.coordinates[0] * SCALE);
  const y = Math.round(f.geometry.coordinates[1] * SCALE);
  // Interchanges (multi-line) get a higher sort priority than single-line stops.
  const priority = (f.properties.station_colors || '').split('-').length;
  stations.push([f.properties.name || '', x - sx, y - sy, priority]);
  sx = x;
  sy = y;
}

writeFileSync(
  OUT,
  JSON.stringify({ scale: SCALE, lines, stations }),
);

const kb = (Buffer.byteLength(readFileSync(OUT)) / 1024).toFixed(1);
console.log(`rail.json: ${lines.length} lines, ${stations.length} stations, ${kb} KB`);
