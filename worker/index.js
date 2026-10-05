// Same-origin proxy for api-open.data.gov.sg; keeps the API key server-side (secret: DATA_GOV_SG_API_KEY).
const API_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
// WAQI JSON map-bounds feed (aqicn.org); token stays server-side (secret: WAQI_TOKEN).
// Only the 480 km radar square is allowed — no open proxy to arbitrary bounds.
// NW→SE corner order: WAQI returns more stations this way than S,W,N,E for the same box.
const AQI_BOUNDS_LATLNG = '5.657912,99.638609,-2.967382,108.290871'; // n,w,s,e
const AQI_BOUNDS_BOX = { west: 99.638609, south: -2.967382, east: 108.290871, north: 5.657912 };

// Allowlist of paths the app uses; anything else is a 404.
const ALLOWED_PREFIXES = [
  '/weather-radar-images/',
  '/weather',
  '/wind-speed',
  '/wind-direction',
  '/air-temperature',
  '/relative-humidity',
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

function aqiError(status, message) {
  return Response.json({ code: status, errorMsg: message }, { status });
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
      return Response.json(
        { code: 0, data: { stations: normalizeAqiStations(raw) } },
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
