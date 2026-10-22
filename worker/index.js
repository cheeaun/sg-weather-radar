// Same-origin proxy for api-open.data.gov.sg; keeps the API key server-side (secret: DATA_GOV_SG_API_KEY).
const API_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
// WAQI JSON map-bounds feed (aqicn.org); token stays server-side (secret: WAQI_TOKEN).
// One request spans the whole ASMC hotspot extent (Sumatra + Pen Malaysia + SG +
// Kalimantan) — strictly a superset of the 480 km radar square, so haze AQI shows
// near the fires. NW→SE corner order: WAQI returns more stations this way than
// S,W,N,E for the same box.
const AQI_BOUNDS_LATLNG = '7.5,92.0,-7.5,120.0'; // n,w,s,e
const AQI_BOUNDS_BOX = { west: 92, south: -7.5, east: 120, north: 7.5 };

// ASMC near-real-time hotspot reports — one plain-text file per region, stable
// URLs, no key. High-confidence detections only, so a single icon tier.
// The region list is both the allowlist and the extent: everything these files
// publish is rendered, with no further geographic filter.
// Both ASMC products are merged. `nrt` is today's partial set and wins any
// collision; `late` is the reprocessed previous day — it finds ~3.5x more fires
// but lags a day, so it's drawn back at reduced opacity.
// Cache lifetimes come from ASMC's publication cadence, not from how live the map
// feels: each product re-issues about twice a day, so a short TTL just re-fetches
// identical bytes. `nrt` is today's accumulating set and takes the shorter span;
// `late` is a fixed previous day, so it barely changes at all.
const HOTSPOT_SOURCES = [
  { src: 'nrt', prefix: 'DailyJP1NOAA20.', cacheTtl: 3 * 60 * 60 },
  { src: 'late', prefix: 'DailyJP1_LATENOAA20.', cacheTtl: 6 * 60 * 60 },
];
const HOTSPOT_REGIONS = ['sumatra', 'p_malaysia', 'singapore', 'kalimantan'];
// ASMC reports one row per 750 m VIIRS pixel, so within a single set neighbouring
// rows sit ~0.5-1 km apart and the same fire on two days repeats at ~0.1-0.4 km.
// 0.25 km therefore catches only genuine cross-set repeats, never a neighbour pixel.
const HOTSPOT_DEDUPE_KM = 0.25;

// Allowlist of paths the app uses; anything else is a 404.
const ALLOWED_PREFIXES = [
  '/weather-radar-images/',
  '/weather',
  '/wind-speed',
  '/wind-direction',
  '/air-temperature',
  '/relative-humidity',
  '/psi',
  '/pm25',
  '/two-hr-forecast',
  '/twenty-four-hr-forecast',
];

// LTA traffic cameras via data.gov.sg v1 (keyless; LTA's own DataMall API now
// exposes the same reduced set). Normalized to the app's { code: 0, data }
// envelope so the client cache accepts it. An optional date_time (SGT,
// YYYY-MM-DDTHH:mm:ss) returns the archive snapshot nearest that time — frame
// URLs are immutable, so old queries edge-cache for a day.
async function trafficImages(searchParams) {
  const dt = searchParams?.get('date_time');
  const valid = !!dt && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dt);
  const stale = valid && Date.now() - Date.parse(`${dt}+08:00`) > 15 * 60 * 1000;
  const url =
    'https://api.data.gov.sg/v1/transport/traffic-images' + (valid ? `?date_time=${dt}` : '');
  let raw;
  try {
    const upstreamRes = await fetch(url, { cf: { cacheTtl: stale ? 86400 : 60 } });
    if (!upstreamRes.ok) throw new Error(`data.gov.sg ${upstreamRes.status}`);
    raw = await upstreamRes.json();
  } catch (e) {
    return Response.json({ code: 502, errorMsg: `Traffic upstream error: ${e.message}` }, { status: 502 });
  }
  const cameras = (raw?.items?.[0]?.cameras || [])
    .map((cam) => ({
      id: cam.camera_id ?? null,
      lat: Number(cam?.location?.latitude),
      lng: Number(cam?.location?.longitude),
      image: cam?.image,
      time: cam?.timestamp || null,
    }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && c.image);
  return Response.json({ code: 0, data: { cameras } });
}

// LTA traffic incidents via DataMall (keyless on data.gov.sg). Secret:
// LTA_DATAMALL_KEY; without it the toggle degrades like AQI without WAQI_TOKEN.
async function trafficIncidents(env) {
  const key = env.LTA_DATAMALL_KEY;
  if (!key) {
    return Response.json({ code: 503, errorMsg: 'LTA_DATAMALL_KEY not configured' }, { status: 503 });
  }
  try {
    const upstreamRes = await fetch('https://datamall2.mytransport.sg/ltaodataservice/TrafficIncidents', {
      headers: { AccountKey: key, accept: 'application/json' },
      cf: { cacheTtl: 60 },
    });
    if (!upstreamRes.ok) throw new Error(`DataMall ${upstreamRes.status}`);
    const raw = await upstreamRes.json();
    const incidents = (Array.isArray(raw) ? raw : raw?.value || [])
      .map((inc) => ({
        type: inc.Type || '',
        lat: Number(inc.Latitude),
        lng: Number(inc.Longitude),
        message: String(inc.Message || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((i) => Number.isFinite(i.lat) && Number.isFinite(i.lng) && i.message);
    return Response.json({ code: 0, data: { incidents } });
  } catch (e) {
    return Response.json({ code: 502, errorMsg: `Traffic upstream error: ${e.message}` }, { status: 502 });
  }
}

// Leading row number then lng/lat. The lookahead (not an end anchor) tolerates
// extra trailing columns — ASMC already ships confidence and FRP in the KML twin,
// and requiring end-of-line there would silently drop every row. Header lines
// still fail on `^\s*\d+` (`S/No…`, `Total Hotspot Count:…`, `====`).
const HOTSPOT_ROW_RE = /^\s*\d+\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?=\s|$)/;

// Reports repeat one block per satellite pass; each row inherits its block's
// UTC stamp. Machine-generated shape, so line regexes beat a parser here.
function parseHotspotReport(text) {
  const out = [];
  let time = null;
  for (const line of String(text).split(/\r?\n/)) {
    const dt = line.match(/^Date & Time:\s*(\d{4})\/(\d{2})\/(\d{2})(?:\s+([\d:]+))?/);
    if (dt) {
      time = `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4] || '00:00:00'}Z`;
      continue;
    }
    const row = HOTSPOT_ROW_RE.exec(line);
    if (!row) continue;
    const lng = Number(row[1]);
    const lat = Number(row[2]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push({ lng, lat, time });
  }
  return out;
}

const HOTSPOT_BASE = 'https://asmc.asean.org/files/msscommunity/hotspots/';

function hotspotDistanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// NRT wins: a reprocessed row is dropped when it repeats an NRT one. Strictly
// one-directional — `late` never suppresses `nrt`, so today's set is always whole.
function dedupeHotspots(nrt, late) {
  return [
    ...nrt,
    ...late.filter((b) => !nrt.some((a) => hotspotDistanceKm(a, b) <= HOTSPOT_DEDUPE_KM)),
  ];
}

// Eight files in flight (two products x four regions). One file failing must not
// blank the others.
async function hotspots() {
  const fetched = await Promise.all(
    HOTSPOT_SOURCES.flatMap(({ src, prefix, cacheTtl }) =>
      HOTSPOT_REGIONS.map(async (region) => {
        try {
          const res = await fetch(`${HOTSPOT_BASE}${prefix}${region}.txt`, {
            headers: { 'user-agent': 'sg-weather-radar/1.0' },
            cf: { cacheTtl },
          });
          if (!res.ok) return { src, ok: false, points: [], updated: null };
          const text = await res.text();
          const rows = parseHotspotReport(text);
          // Canary: each report states its own row count, so a mismatch means the
          // format drifted and rows are being dropped silently. Compared before the
          // block dedupe below — the reprocessed files legitimately repeat blocks.
          const declared = [...text.matchAll(/Total Hotspot Count:\s*(\d+)/g)].reduce(
            (sum, m) => sum + Number(m[1]),
            0,
          );
          if (declared && rows.length !== declared) {
            console.warn(
              `hotspots: ${prefix}${region} parsed ${rows.length} rows, report declares ${declared}`,
            );
          }
          // The reprocessed reports repeat each pass block, so dedupe the rows.
          const seen = new Set();
          const points = [];
          for (const p of rows) {
            const key = `${p.time}|${p.lng}|${p.lat}`;
            if (seen.has(key)) continue;
            seen.add(key);
            points.push({ ...p, src });
          }
          return {
            src,
            ok: true,
            points,
            updated: text.match(/Created On:\s*(.+)/)?.[1]?.trim() || null,
          };
        } catch {
          return { src, ok: false, points: [], updated: null };
        }
      }),
    ),
  );
  // Every file failing is an outage, not a quiet day — say so, so the client keeps
  // the fires already on screen instead of blanking the overlay. Note this is
  // "zero fetches succeeded", not "zero points": p_malaysia and singapore are
  // legitimately empty every day.
  if (!fetched.some((r) => r.ok)) {
    return Response.json({ code: 502, errorMsg: 'ASMC hotspot upstream error' }, { status: 502 });
  }
  const nrt = fetched.filter((r) => r.src === 'nrt').flatMap((r) => r.points);
  const late = fetched.filter((r) => r.src === 'late').flatMap((r) => r.points);
  const points = dedupeHotspots(nrt, late);
  // The NRT stamp is the one worth surfacing; `late` is always a day behind.
  const updated = fetched.find((r) => r.src === 'nrt' && r.updated)?.updated || null;
  return Response.json({ code: 0, data: { hotspots: points, updated } });
}

// 500 is the EPA AQI cap. Crowd sensors (GAIA AirNet) glitch-pin all channels to
// exactly 500 (e.g. 4 Haig Road, uid -2791069) — pm1 ⊆ pm10 can never be equal, so
// pm1=pm10=pm25=500 is safe as a global pin test; real fire-belt 500s have a
// distinct pollutant mix. map/bounds items carry no pollutant values, so cap
// stations get one feed cross-check each (edge-cached like the bounds feed),
// bounded per response to limit fan-out during a heavy fire season.
const AQI_CAP = 500;
const AQI_GLITCH_CHECK_MAX = 20;

function aqiError(status, message) {
  return Response.json({ code: status, errorMsg: message }, { status });
}

async function pinnedAqiGlitch(station, token) {
  if (!station.uid) return false;
  try {
    const res = await fetch(`https://api.waqi.info/feed/@${station.uid}?token=${encodeURIComponent(token)}`, {
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) return false;
    const iaqi = (await res.json())?.data?.iaqi;
    const v = (k) => iaqi?.[k]?.v;
    return v('pm1') === AQI_CAP && v('pm10') === AQI_CAP && v('pm25') === AQI_CAP;
  } catch {
    return false;
  }
}

function normalizeAqiStations(raw) {
  if (!raw || raw.status !== 'ok' || !Array.isArray(raw.data)) return [];
  const stations = [];
  for (const item of raw.data) {
    const aqiNum = Number(item?.aqi);
    if (!Number.isFinite(aqiNum) || aqiNum < 0) continue;
    // map/bounds items put lat/lon on the item; feed/geo uses station.geo [lat, lng]
    const geo = item?.station?.geo;
    const lat = Number(item?.lat ?? (Array.isArray(geo) ? geo[0] : geo?.lat));
    const lng = Number(item?.lon ?? item?.lng ?? (Array.isArray(geo) ? geo[1] : geo?.lng));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lng < AQI_BOUNDS_BOX.west || lng > AQI_BOUNDS_BOX.east) continue;
    if (lat < AQI_BOUNDS_BOX.south || lat > AQI_BOUNDS_BOX.north) continue;
    stations.push({
      uid: item.uid ?? null,
      aqi: aqiNum,
      lat,
      lng,
      name: item?.station?.name || '',
      time: item?.station?.time || item?.time?.iso || item?.time?.s || null,
    });
  }
  return stations;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const incoming = new URL(request.url);
    const path = incoming.pathname.replace(/^\/api/, '');

    if (path === '/traffic-images') {
      return trafficImages(incoming.searchParams);
    }

    if (path === '/traffic-image') {
      // Same-origin proxy for camera JPEGs (they lack CORS headers, so canvas
      // reads need this). Allowlisted to the images host only — no open proxy.
      // Frame URLs are immutable: edge-cache a day.
      const u = incoming.searchParams.get('url');
      if (!u || !u.startsWith('https://images.data.gov.sg/')) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      const upstreamRes = await fetch(u, { cf: { cacheTtl: 86400, cacheEverything: true } });
      return new Response(upstreamRes.body, {
        headers: {
          'content-type': 'image/jpeg',
          'cache-control': 'public, max-age=86400',
        },
      });
    }

    if (path === '/traffic-incidents') {
      return trafficIncidents(env);
    }

    if (path === '/hotspots') {
      return hotspots();
    }

    if (path === '/aqi-stations') {
      const token = env.WAQI_TOKEN;
      if (!token || token === 'demo') {
        return aqiError(503, 'WAQI_TOKEN not configured');
      }
      // 5 min edge cache; station JSON moves slowly.
      const url = `https://api.waqi.info/v2/map/bounds/?latlng=${AQI_BOUNDS_LATLNG}&token=${encodeURIComponent(token)}`;
      let raw;
      try {
        const upstreamRes = await fetch(url, { cf: { cacheTtl: 300 } });
        if (!upstreamRes.ok) return aqiError(502, `AQI upstream ${upstreamRes.status}`);
        raw = await upstreamRes.json();
      } catch {
        return aqiError(502, 'AQI upstream error');
      }
      if (!raw || raw.status !== 'ok') {
        return aqiError(502, raw?.data || 'AQI upstream error');
      }
      let stations = normalizeAqiStations(raw);
      // Glitched cap pins across the whole box; a heavy fire season can put many
      // stations at 500, so at most AQI_GLITCH_CHECK_MAX feed probes per refresh.
      // Pins are dropped outright — no sensor data means nothing to render.
      const capped = stations.filter((s) => s.aqi === AQI_CAP);
      const checks = await Promise.allSettled(
        capped.slice(0, AQI_GLITCH_CHECK_MAX).map((s) => pinnedAqiGlitch(s, token)),
      );
      const pinned = new Set(
        checks.flatMap((c, i) => (c.status === 'fulfilled' && c.value ? [capped[i].uid] : [])),
      );
      stations = stations.filter((s) => !pinned.has(s.uid));
      return Response.json(
        { code: 0, data: { stations } },
        { headers: { 'x-upstream-url': url.replace(token, '***') } },
      );
    }

    if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // path is absolute — new URL(path, base) would drop API_BASE's path, so concatenate
    const url = API_BASE + path + incoming.search;
    // Edge-cached 30s: feeds update at most once a minute, so HITs are never more than 30s stale
    const upstreamRes = await fetch(url, {
      headers: { 'x-api-key': env.DATA_GOV_SG_API_KEY },
      cf: { cacheTtl: 30 },
    });

    const res = new Response(upstreamRes.body, upstreamRes);
    res.headers.set('x-upstream-url', url);
    return res;
  },
};
