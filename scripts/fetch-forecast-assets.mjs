// Download MSS weather icons + rain legend from weather.gov.sg into forecast-assets/.
// Re-run: node scripts/fetch-forecast-assets.mjs (URLs are stable theme paths).
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'forecast-assets');
const IMG = 'https://www.weather.gov.sg/wp-content/themes/wiptheme/assets/img';
const THEME = 'https://www.weather.gov.sg/wp-content/themes/wiptheme';

// 75x75 masters; -sm (35px) and -small (23px) are scaled copies of the same art.
const CONDITIONS = [
  'fair-day',
  'fair-night',
  'fair-warm',
  'partly-cloudy-day',
  'partly-cloudy-night',
  'cloudy',
  'hazy',
  'slightly-hazy',
  'windy',
  'mist',
  'light-rain',
  'moderate-rain',
  'heavy-rain',
  'shower',
  'heavy-showers',
  'thundery-showers',
  'heavy-thundery-showers',
  'drizzle',
  'overcast',
  'sunny',
  'rainy',
  'windy-rain',
  'windy-showers',
  'windy-cloudy',
  'windy-fair',
  'strong-winds',
  'strong-winds-rain',
  'strong-winds-showers',
];
const WIND_DIRS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];
const MISC = ['icon-rain-drop-md.png', 'icon-thermometer-hot-md.png', 'icon-thermometer-cold-md.png'];

const jobs = [
  ...CONDITIONS.map((s) => [`${IMG}/icon-${s}.png`, `icons/${s}.png`]),
  ...WIND_DIRS.map((d) => [`${IMG}/icon-wind-dir-sm-${d}.png`, `icons/wind/sm/${d}.png`]),
  ...WIND_DIRS.map((d) => [`${IMG}/icon-wind-dir-lg-${d}.png`, `icons/wind/lg/${d}.png`]),
  ...MISC.map((f) => [`${IMG}/${f}`, `icons/misc/${f.replace('icon-', '').replace('.png', '')}.png`]),
  [`${THEME}/images/rain-intensity.jpg`, 'legends/rain-intensity.jpg'],
];

let ok = 0;
for (const [url, rel] of jobs) {
  const res = await fetch(url, { headers: { 'user-agent': 'sg-weather-radar/fetch-forecast-assets' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const out = join(ROOT, rel);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  ok++;
}
console.log(`forecast-assets: ${ok}/${jobs.length} files`);

// Quantize the PNGs in place so regenerating doesn't undo their compression.
// Skips gracefully when pngquant isn't on PATH.
let quantized = 0;
for (const [, rel] of jobs) {
  if (!rel.endsWith('.png')) continue;
  try {
    execFileSync('pngquant', ['--force', '--ext', '.png', '--quality=65-90', '--speed', '1', join(ROOT, rel)]);
    quantized++;
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('pngquant not found; PNGs left uncompressed');
      break;
    }
    if (err.status !== 99) console.warn(`pngquant failed for ${rel}: ${err.message}`);
    else quantized++;
  }
}
if (quantized) console.log(`forecast-assets: quantized ${quantized} PNGs`);
