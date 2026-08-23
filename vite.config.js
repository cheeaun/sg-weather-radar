import { cloudflare } from '@cloudflare/vite-plugin';

export default {
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  plugins: [
    cloudflare(),
  ],
};
