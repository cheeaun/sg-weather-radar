import { readFileSync } from 'node:fs';
import { cloudflare } from '@cloudflare/vite-plugin';
import { VitePWA } from 'vite-plugin-pwa';

// Bake AQI UI into the bundle (no runtime probe). Override with VITE_AQI_UI=1|0.
function aqiUiEnabled() {
  const flag = process.env.VITE_AQI_UI;
  if (flag != null && flag !== '') return flag !== '0' && flag !== 'false';
  if (process.env.WAQI_TOKEN) return true;
  try {
    return /^WAQI_TOKEN=.+/m.test(readFileSync('.dev.vars', 'utf8'));
  } catch {
    return false;
  }
}

export default {
  optimizeDeps: {
    // @scritto/core prebundle 504'd in dev; serve the package entry directly.
    exclude: ['maplibre-gl', '@scritto/core'],
  },
  define: {
    'import.meta.env.VITE_AQI_UI': JSON.stringify(aqiUiEnabled() ? '1' : '0'),
  },
  plugins: [
    // Generates /sw.js at build: precaches the hashed bundle assets, caches
    // OpenFreeMap basemap tiles cache-first for offline/slow-net map rendering.
    // registerType prompt = hold new SW in waiting; main.js shows an update
    // toast (no PWA, manifest is off).
    VitePWA({
      strategies: 'generateSW',
      manifest: false,
      injectRegister: false, // main.js registers it itself (dev stays SW-free)
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'favicon-64.png', 'apple-touch-icon.png'],
      workbox: {
        navigateFallback: '/',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname === 'tiles.openfreemap.org',
            handler: 'CacheFirst',
            options: {
              cacheName: 'sgwr-tiles',
              expiration: { maxEntries: 600, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
    cloudflare(),
  ],
};
