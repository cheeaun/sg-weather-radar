// Same-origin proxy for api-open.data.gov.sg; keeps the API key server-side (secret: DATA_GOV_SG_API_KEY).
const API_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';

// Allowlist of paths the app uses; anything else is a 404.
const ALLOWED_PREFIXES = [
  '/weather-radar-images/',
  '/weather',
  '/wind-speed',
  '/wind-direction',
];

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    const incoming = new URL(request.url);
    const path = incoming.pathname.replace(/^\/api/, '');

    if (!ALLOWED_PREFIXES.some((p) => path.startsWith(p))) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    // path is absolute — new URL(path, base) would drop API_BASE's path, so concatenate
    const upstream = new URL(API_BASE + path + incoming.search);
    const upstreamRes = await fetch(upstream, {
      headers: { 'x-api-key': env.DATA_GOV_SG_API_KEY },
    });

    const res = new Response(upstreamRes.body, upstreamRes);
    res.headers.set('x-upstream-url', upstream.toString());
    return res;
  },
};
