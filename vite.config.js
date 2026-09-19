import { cloudflare } from '@cloudflare/vite-plugin';

export default {
  optimizeDeps: {
    // @scritto/core prebundle 504'd in dev; serve the package entry directly.
    exclude: ['maplibre-gl', '@scritto/core'],
  },
  plugins: [
    cloudflare(),
  ],
};
