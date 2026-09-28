import { readFileSync } from 'node:fs';
import { cloudflare } from '@cloudflare/vite-plugin';

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
    cloudflare(),
  ],
};
