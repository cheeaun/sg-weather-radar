# AGENTS.md

## Commands

- `npm run dev` — dev server on port 5151 (site + Worker-served `/api` proxy; needs `.dev.vars`)
- `cloudflared tunnel --url http://localhost:5151 --http-host-header localhost:5151` — expose the dev server via a quick tunnel; always pass `--http-host-header`, since `server.allowedHosts` is not configured and Vite blocks non-localhost Host headers
- `npm run build` — production build to `dist/`
- `npm run preview` — run the build in the local Workers runtime
- `npm run format` — format `index.html`, `main.js`, and `styles.css` with oxfmt
- `npx wrangler deploy` — deploy site + API proxy as one Worker (run `npm run build` first)
- `node scripts/generate-icons.mjs` — regenerate `public/` icons from `design/icon.svg`

No lint, typecheck, or test commands exist.

## Environment

Local dev requires `.dev.vars` (copy from `.dev.vars.example`; gitignored) with:

```
DATA_GOV_SG_API_KEY=<data.gov.sg API key>
```

Production uses the encrypted Cloudflare secret of the same name (`npx wrangler secret put DATA_GOV_SG_API_KEY`). Never commit the key or put it in client-visible code — the whole point of the proxy.

Never commit `.env`, `.dev.vars`, or the API key. Never deploy without being asked.

## Project Structure

Single-page vanilla web app deployed as one Cloudflare Worker: static assets + a same-origin `/api/*` proxy (`worker/index.js`), wired together by the Cloudflare Vite plugin.

- `index.html` — page markup; references `/styles.css` and `/main.js`. One inline `<script>` in `<head>` applies a stored theme override before paint — keep it inline to avoid a flash.
- `styles.css` — all styles (`:root` CSS custom properties handle theming)
- `main.js` — ES module with all app logic
- `worker/index.js` — Worker entry: proxies allowlisted `/api/*` paths to `api-open.data.gov.sg`, injecting the API key server-side; upstream fetches are edge-cached 30s via `cf: { cacheTtl: 30 }`
- `wrangler.jsonc` — Worker config (`sg-weather-radar`); assets with SPA fallback, `run_worker_first: ["/api/*"]`
- `vite.config.js` — `cloudflare()` plugin only. MapLibre's worker is wired via `?worker&url` in `main.js` (per MapLibre v6 docs) so Vite emits it as a self-contained chunk — don't switch back to plain `?url`, which emits the worker verbatim without its `maplibre-gl-shared.mjs` sibling and breaks the map in production builds.
- `.dev.vars.example` — template for the gitignored `.dev.vars` local secret file
- `design/icon.svg` — icon master (64×64 grid); all `public/` favicon/tree icons are generated from it by `scripts/generate-icons.mjs` — never edit `public/` icon files directly
- Dependencies at runtime: `maplibre-gl` only; Vite is the bundler
- `.oxfmtrc.json` — oxfmt config; single quotes for JS

## Architecture Notes

- The app calls same-origin `/api/*` paths only (`apiURL()` in `main.js`); the data.gov.sg API key exists solely in the Worker (`env.DATA_GOV_SG_API_KEY`, sent as the `x-api-key` header). Watch URL construction in the Worker: `new URL(absolutePath, base)` silently drops the base's path — concatenate `API_BASE + path` instead.
- Radar frames from three ranges (70/240/480 km) are rendered inside the map as `image` sources + `raster` layers (`radar-70` on top of `radar-240` on top of `radar-480`, all below boundary layers). Frames are first composited into 480×480 canvases (`buildRadarCanvas` in `main.js`): rows resampled from equirectangular to Web-Mercator spacing (API images are EPSG:4326; the map stretches textures evenly in Mercator Y), and with clipping on, whole pixels whose centers fall inside the inner range's box — eroded inward by half an outer texel so the inner quad always covers the hole — are `clearRect`ed. `resampling: 'nearest'` keeps pixel edges hard. Composed canvases are memoized in `frameImageCache` (LRU, 24) keyed by URL + clip state; frame loads are direct CORS fetches from the data.gov.sg CDN.
- All timestamps across ranges are intersected into `allTimestamps`; the time slider indexes into this.
- API responses are cached in `sessionStorage` with prefix `sgwr-api:` and a 60s TTL; first render uses cache synchronously, then a network refresh replaces it if newer data exists. The Worker stays a passthrough proxy; its upstream fetch sets `cf: { cacheTtl: 30 }` so Cloudflare's edge cache absorbs repeat traffic (feeds update at most once a minute → HITs are ≤30s stale). Local dev always shows `cf-cache-status: DYNAMIC` — workerd doesn't simulate the CDN cache; the caching is production-only behavior.
- Abuse protection is the 30s edge cache alone — intentional, no rate limiter (a per-IP `ratelimits` binding was tried and removed for minimalism; don't re-add one unless abuse actually shows up). Repeat requests for a URL never reach upstream; floods of *distinct* URLs (arbitrary date/query params, each a cache miss) would. data.gov.sg's own 429s are the backstop (v2 realtime: 6/12/30 calls per 10s by key tier), which the app rides out on its sessionStorage cache.
- Map: OpenFreeMap styles; style URL swaps on theme change via `map.setStyle()`. Overlay stack is rebuilt on `style.load` in this order: radar rasters → `land-outline` (coastline `line` layer from the style's `openmaptiles` source, `water`/`class=ocean`, so rain stays readable against land) → `land-outline-inland` (same source, `lake`/`pond`/`river`/`canal` classes, `minzoom: 12` so inland water edges only join when zoomed in) → `wind-layer` → boundary outline/label layers → lightning. Base-style place-label symbol layers (`source-layer: 'place'`; IDs differ per style, e.g. `place_*` vs `label_*`) are `moveLayer`ed to the top so country/state/region names stay readable above everything.
- Wind particles: NEA station wind speed + direction (data.gov.sg real-time APIs) are merged into u/v vectors and interpolated onto a masked IDW grid (field fades to zero away from stations). Particles animate on an offscreen 2D canvas (persistent trails via `destination-in` fades, batched color-bucket strokes) that a `wind-layer` custom layer uploads as a texture and composites fullscreen — it's a real map layer stacked above the radar rasters and the `land-outline` coastline, and below boundary/lightning layers, so rearrange it like any other; `prefers-reduced-motion` gets a one-shot static streamline render instead.
- Theme is CSS-first: `:root` holds light values, a `@media (prefers-color-scheme: dark)` query handles the system default, and `:root[data-theme="dark"]` forces dark. A `<meta name="color-scheme">` and the `color-scheme` property keep native UI in sync. JS only sets/removes the `data-theme` attribute for explicit `localStorage['sgwr-theme']` overrides (`system` | `light` | `dark`) and swaps the map style via `map.setStyle()`; an inline head script applies a stored override before paint to avoid flash.
- Settings: opacity (`sgwr-radar-opacity`), boundary clipping (`sgwr-radar-clip`), lightning overlay (`sgwr-lightning`), wind particles (`sgwr-wind`, default off) — all persisted in `localStorage`.
- All times displayed in `Asia/Singapore`.

## Conventions

- Comments sparingly: 1 line, 2 max for genuinely complex constraints. No wordy multi-line explanations.
- No additions unless explicitly needed. JS/CSS live in `main.js`/`styles.css`; keep `index.html` markup-only except the pre-paint theme script.
- Format after editing with `npm run format` (oxfmt).
- System font stack only; no external fonts or UI libraries.
- Respect `prefers-reduced-motion`.
- Verify changes by running `npm run dev` and manually checking the app.
