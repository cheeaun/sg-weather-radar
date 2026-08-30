// Builds all generated rain-summary data from the URA planning-area source.
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = new URL('../data/sg-planning-area.geojson', import.meta.url);
const PIXEL_OUT = new URL('../rain-pixels.json', import.meta.url);
const INDEX_OUT = new URL('../areas-idx.json', import.meta.url);
const SCALE = 1e5;
const SIMPLIFY_EPSILON = 100;
const W = 480;
const H = 480;
const BB = {
  upperLeft: { longitude: 103.342685, latitude: 1.97854 },
  lowerRight: { longitude: 104.602315, latitude: 0.719515 },
};

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

function simplifyRing(ring, eps) {
  const open = ring.slice(0, -1);
  const n = open.length;
  if (n < 6) return ring;
  const [x0, y0] = open[0];
  let far = 1;
  let maxd = -1;
  for (let i = 1; i < n; i++) {
    const d = (open[i][0] - x0) ** 2 + (open[i][1] - y0) ** 2;
    if (d > maxd) {
      maxd = d;
      far = i;
    }
  }
  const a = simplify(open.slice(0, far + 1), eps);
  const b = simplify(open.slice(far).concat([open[0]]), eps);
  const merged = a.concat(b.slice(1, -1));
  merged.push([merged[0][0], merged[0][1]]);
  return merged;
}

const REGION_MAP = {
  'NORTH REGION': 'north',
  'NORTH-EAST REGION': 'north-east',
  'EAST REGION': 'east',
  'WEST REGION': 'west',
  'CENTRAL REGION': 'central',
};

function titleCase(s) {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAnd\b/g, 'and')
    .replace(/\bOf\b/g, 'of')
    .replace(/\bThe\b/g, 'the');
}

const geo = JSON.parse(readFileSync(SRC, 'utf8'));
const areas = [];
let rawPts = 0;
let keptPts = 0;

for (const f of geo.features) {
  const props = f.properties;
  const region = REGION_MAP[props.REGION_N];
  if (!region) {
    console.warn(`Unknown region: ${props.REGION_N} for ${props.PLN_AREA_N}; skipping`);
    continue;
  }
  const areaRings = [];
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const poly of polys) {
    const pts = poly[0].map(([lng, lat]) => [Math.round(lng * SCALE), Math.round(lat * SCALE)]);
    rawPts += pts.length;
    const simp = simplifyRing(pts, SIMPLIFY_EPSILON);
    if (simp.length < 4) continue;
    keptPts += simp.length;
    const flat = [];
    for (let i = 0; i < simp.length; i++) {
      flat.push(i === 0 ? simp[i][0] : simp[i][0] - simp[i - 1][0]);
      flat.push(i === 0 ? simp[i][1] : simp[i][1] - simp[i - 1][1]);
    }
    areaRings.push(flat);
  }
  if (areaRings.length) areas.push({ name: titleCase(props.PLN_AREA_N), region, rings: areaRings });
}

console.log(
  `planning areas: ${areas.length} areas, ${areas.reduce((n, a) => n + a.rings.length, 0)} rings, ${keptPts}/${rawPts} points`,
);

function mercatorY(lat) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}
function mercatorLat(y) {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}
function pointInRing(lx, ly, ring, bb) {
  if (lx < bb.minLx || lx > bb.maxLx || ly < bb.minLy || ly > bb.maxLy) return false;
  let hit = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i];
    const yi = ring[i + 1];
    if (xi > lx !== ring[j] > lx && ly < ((ring[j + 1] - yi) * (lx - xi)) / (ring[j] - xi) + yi)
      hit = !hit;
  }
  return hit;
}

const ringBboxes = [];
const rings = [];
const ringAreaIdx = [];
for (let a = 0; a < areas.length; a++) {
  for (const flat of areas[a].rings) {
    const pts = new Array(flat.length);
    let minLx = Infinity;
    let maxLx = -Infinity;
    let minLy = Infinity;
    let maxLy = -Infinity;
    let x = 0;
    let y = 0;
    for (let i = 0; i < flat.length; i += 2) {
      x += flat[i];
      y += flat[i + 1];
      pts[i] = x;
      pts[i + 1] = y;
      if (x < minLx) minLx = x;
      if (x > maxLx) maxLx = x;
      if (y < minLy) minLy = y;
      if (y > maxLy) maxLy = y;
    }
    rings.push(pts);
    ringBboxes.push({ minLx, maxLx, minLy, maxLy });
    ringAreaIdx.push(a);
  }
}

const lonSpan = BB.lowerRight.longitude - BB.upperLeft.longitude;
const yTop = mercatorY(BB.upperLeft.latitude);
const yBot = mercatorY(BB.lowerRight.latitude);
let minX = W;
let maxX = 0;
let minY = H;
let maxY = 0;
for (const bb of ringBboxes) {
  const px0 = Math.floor(((bb.minLx / SCALE - BB.upperLeft.longitude) / lonSpan) * W);
  const px1 = Math.ceil(((bb.maxLx / SCALE - BB.upperLeft.longitude) / lonSpan) * W);
  const py0 = Math.floor(((yTop - mercatorY(bb.maxLy / SCALE)) / (yTop - yBot)) * H);
  const py1 = Math.ceil(((yTop - mercatorY(bb.minLy / SCALE)) / (yTop - yBot)) * H);
  if (px0 < minX) minX = px0;
  if (px1 > maxX) maxX = px1;
  if (py0 < minY) minY = py0;
  if (py1 > maxY) maxY = py1;
}
minX = Math.max(0, minX);
maxX = Math.min(W - 1, maxX);
minY = Math.max(0, minY);
maxY = Math.min(H - 1, maxY);

const pixels = [];
for (let y = minY; y <= maxY; y++) {
  const lat = mercatorLat(yTop + ((y + 0.5) / H) * (yBot - yTop));
  for (let x = minX; x <= maxX; x++) {
    const lng = BB.upperLeft.longitude + ((x + 0.5) / W) * lonSpan;
    const lx = Math.round(lng * SCALE);
    const ly = Math.round(lat * SCALE);
    for (let r = 0; r < rings.length; r++) {
      if (pointInRing(lx, ly, rings[r], ringBboxes[r])) {
        pixels.push(x, y, ringAreaIdx[r]);
        break;
      }
    }
  }
}

const pixelData = new Array((pixels.length / 3) * 2);
let previousPixel = 0;
for (let i = 0, o = 0; i < pixels.length; i += 3, o += 2) {
  const pixel = pixels[i + 1] * W + pixels[i];
  pixelData[o] = pixel - previousPixel;
  pixelData[o + 1] = pixels[i + 2];
  previousPixel = pixel;
}
writeFileSync(PIXEL_OUT, JSON.stringify(pixelData));
console.log(`rain-pixels.json: ${pixels.length / 3} pixels, ${(Buffer.byteLength(readFileSync(PIXEL_OUT)) / 1024).toFixed(1)} KB`);

const index = areas.map((a) => [a.name, a.region]);
writeFileSync(INDEX_OUT, JSON.stringify(index));
console.log(`areas-idx.json: ${index.length} areas, ${(Buffer.byteLength(readFileSync(INDEX_OUT)) / 1024).toFixed(1)} KB`);
