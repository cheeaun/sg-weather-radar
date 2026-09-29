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
