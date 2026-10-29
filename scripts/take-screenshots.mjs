import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';

// Re-encode: Playwright's JPEG encoder is plain and larger at equal quality.
async function optimize(name) {
  const buf = await sharp(name).jpeg({ quality: 75, mozjpeg: true }).toBuffer();
  await writeFile(name, buf);
}

// MapLibre's compact attribution expands on :focus-within, so collapse it and
// blur whatever holds focus before capturing.
async function minimizeAttribution(page) {
  await page.mouse.move(187, 300);
  await page.evaluate(() => document.activeElement?.blur());
  const expanded = await page
    .locator('.maplibregl-ctrl-attrib')
    .evaluate((el) => el.classList.contains('maplibregl-compact-show'));
  if (expanded) {
    await page.locator('.maplibregl-ctrl-attrib-button').click();
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(187, 300);
  }
}

// The "no radar yet" placeholder blends light 45° stripes into the basemap's
// gray sea. A clean sea tile is uniform (~1% pixels above the sea's value);
// hatched, the stripes push that past 10%. Open water east of the peninsula:
// no islands or labels to false-positive.
async function hatched(buf) {
  const tile = { left: 470, top: 470, width: 60, height: 60 };
  const { data } = await sharp(buf).extract(tile).raw().toBuffer({ resolveWithObject: true });
  let light = 0;
  for (let i = 0; i < data.length; i += 3) if (data[i] > 200) light++;
  return light / (data.length / 3) > 0.05;
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 375, height: 667 },
  deviceScaleFactor: 2,
});

// Shot 1: light theme, zoomed out to the 480 km fit
await page.goto('http://localhost:5151/', { waitUntil: 'networkidle' });
await page.waitForTimeout(8000);
const toggle = page.locator('.range-toggle-ctrl button').first();
for (let i = 0; i < 3; i++) await toggle.click();
await page.waitForTimeout(12000);
await minimizeAttribution(page);
// The slider can land on a slot whose 240/480 frames haven't published yet;
// the app re-polls until they do, so retry until the hatch clears.
for (let i = 0; ; i++) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 85 });
  if (!(await hatched(buf)) || i >= 10) {
    await writeFile('screenshot-1.jpg', buf);
    break;
  }
  console.log('hatch detected, retrying…');
  await page.waitForTimeout(10000);
}
await optimize('screenshot-1.jpg');

// Shot 2: dark theme, default Singapore fit
const page2 = await browser.newPage({
  viewport: { width: 375, height: 667 },
  deviceScaleFactor: 2,
});
await page2.addInitScript(() => localStorage.setItem('sgwr-theme', 'dark'));
await page2.goto('http://localhost:5151/', { waitUntil: 'networkidle' });
await page2.waitForTimeout(12000);
await minimizeAttribution(page2);
await page2.waitForTimeout(1000);
await page2.screenshot({ path: 'screenshot-2.jpg', type: 'jpeg', quality: 85 });
await optimize('screenshot-2.jpg');

await browser.close();
