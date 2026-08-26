# SG Weather Radar

Real-time Singapore rainfall radar on a MapLibre GL map, powered by [NEA data via data.gov.sg](https://data.gov.sg).

**Live site:** <https://sg-weather-radar.cheeaun.workers.dev>

Runs as a single Cloudflare Worker: the site is served as static assets and `/api/*` requests are proxied server-side so the data.gov.sg API key is never exposed to the browser. Built with the [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/).

## Features

- Radar imagery composited from three ranges (70 km, 240 km, 480 km) centered on Singapore
- Time scrubber over the past hour of radar frames
- Auto-refresh aligned to 5-minute feed slots: polls every 30s until a slot's data is complete, then idles until the next slot (pausing when hidden)
- MRT/LRT lines and stations overlay
- Optional cloud-to-ground lightning overlay
- Optional (off by default) wind particle animation driven by station wind readings
- System / light / dark themes with matching map styles
- Adjustable radar opacity and boundary clipping
- Geolocate and navigation controls
- Responsive layout with a mobile settings sheet

## Data Sources

- Radar images: [NEA Weather Radar Images API](https://data.gov.sg/datasets/d_418e9ac3414fd927b7405631e0a7bc82/view) via `api-open.data.gov.sg` (proxied through the Worker)
- Lightning: [NEA Lightning API](https://data.gov.sg/datasets/d_08238953fe0f6dd13f10714ebfbcb9f9/view) via `api-open.data.gov.sg` (proxied through the Worker)
- Wind speed & direction: [NEA Wind Speed API](https://data.gov.sg/datasets/d_7677738484067741bf3b56ab5d69c7e9/view) / [NEA Wind Direction API](https://data.gov.sg/datasets/d_534cf203023b51f51f879145ccc56ff9/view) via `api-open.data.gov.sg` (proxied through the Worker)
- Rail lines & stations: [cheeaun/sgraildata](https://github.com/cheeaun/sgraildata), compiled to `rail.json` by `scripts/build-rail-data.mjs` and bundled with the app
- Map tiles: [OpenFreeMap](https://openfreemap.org)

Data from data.gov.sg is covered by the [Singapore Open Data Licence](https://data.gov.sg/open-data-licence).

## Setup

1. Install dependencies:
   ```sh
   npm install
   ```
2. Copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in your data.gov.sg API key (create a free data.gov.sg account, then generate a key from the API tab of any dataset page):
   ```sh
   cp .dev.vars.example .dev.vars
   ```
3. Start the dev server:
   ```sh
   npm run dev
   ```
   The app runs at http://localhost:5151. The site and the `/api/*` proxy both run locally via the Cloudflare Vite plugin (the Worker code executes in workerd).

## Deploy to production

One-time (per machine): `npx wrangler login`.

One-time (per Worker): set the production API key as an encrypted secret — never in any file:
```sh
npx wrangler secret put DATA_GOV_SG_API_KEY
```

Then build and deploy:
```sh
npm run build
npx wrangler deploy
```

The site and the API proxy deploy together as one Worker (`wrangler.jsonc`: `sg-weather-radar`). The app calls same-origin `/api/*` paths (`worker/index.js` allowlists the routes and injects the key via the `x-api-key` header).

### Deploy via GitHub Actions

Pushing to `main` (or running the [Deploy](.github/workflows/deploy.yml) workflow manually) builds and deploys the Worker in CI. Add these repository secrets once (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — create one with the "Edit Cloudflare Workers" template
- `CLOUDFLARE_ACCOUNT_ID`

`DATA_GOV_SG_API_KEY` needs no CI counterpart; it lives as an encrypted Cloudflare secret on the Worker and persists across deploys.

## Build

```sh
npm run build    # outputs to dist/
npm run preview  # runs the build in the Workers runtime locally
```

## Rail data

The bundled `rail.json` (MRT/LRT lines + stations) is generated from `data/sg-rail.geojson` ([cheeaun/sgraildata](https://github.com/cheeaun/sgraildata)) — coordinates are delta-encoded and simplified to keep the bundle small:

```sh
node scripts/build-rail-data.mjs
```

Only rerun this when updating the underlying rail dataset.

## Icons

The icon master is `design/icon.svg` (64×64 grid, pixelated radar-echo cells colored with the reflectivity swatch). `public/` icons are derived from it — never edit them directly:

```sh
node scripts/generate-icons.mjs
```

This writes `public/favicon.svg`, `public/apple-touch-icon.svg` (full-bleed, no corner radius), plus rasterized `favicon-64.png` and `apple-touch-icon.png` (requires `rsvg-convert`).

## License

[MIT](LICENSE)
