// Probe PUB flood alerts + rainfall. Default: brief when dry, full dump when raining (or alerts exist).
// Usage:
//   node scripts/check-flood-alerts.mjs
//   node scripts/check-flood-alerts.mjs --force          # always full dump
//   node scripts/check-flood-alerts.mjs --date=2026-09-22
//   node scripts/check-flood-alerts.mjs --date=2026-09-22 --walk
//   node scripts/check-flood-alerts.mjs --json
//   node scripts/check-flood-alerts.mjs --watch          # loop every 30s while raining
// Needs DATA_GOV_SG_API_KEY in .dev.vars (same key as the Worker).
import { readFileSync } from 'node:fs';

const API_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const WET_MM = 0.5; // 5-min total at or above this counts as raining at a gauge
const WET_STATIONS = 5; // this many wet gauges = "raining in Singapore"

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

function loadApiKey() {
  try {
    const raw = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    const line = raw.split('\n').find((l) => l.startsWith('DATA_GOV_SG_API_KEY='));
    return line ? line.slice('DATA_GOV_SG_API_KEY='.length).trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

const apiKey = loadApiKey();
if (!apiKey) {
  console.error('Missing DATA_GOV_SG_API_KEY in .dev.vars');
  process.exit(1);
}

async function get(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.code === 24) {
    const msg = body?.errorMsg || res.statusText;
    const err = new Error(`${res.status} ${msg}`);
    err.rateLimited = body?.code === 24 || res.status === 429;
    throw err;
  }
  return body;
}

async function fetchRain() {
  const body = await get('/rainfall');
  const data = body?.data || {};
  const names = new Map((data.stations || []).map((s) => [s.id, s.name]));
  const latest = (data.readings || []).at(-1);
  const rows = (latest?.data || [])
    .map((r) => ({
      id: r.stationId,
      name: names.get(r.stationId) || r.stationId,
      mm: Number(r.value),
    }))
    .filter((r) => Number.isFinite(r.mm))
    .sort((a, b) => b.mm - a.mm);
  const wet = rows.filter((r) => r.mm >= WET_MM);
  return {
    timestamp: latest?.timestamp || null,
    unit: data.readingUnit || 'mm',
    type: data.readingType || '',
    rows,
    wet,
    max: rows[0]?.mm ?? 0,
  };
}

async function fetchFloodPage({ date, paginationToken } = {}) {
  const q = new URLSearchParams();
  if (date) q.set('date', date);
  if (paginationToken) q.set('paginationToken', paginationToken);
  const path = `/weather/flood-alerts${q.size ? `?${q}` : ''}`;
  const body = await get(path);
  return {
    records: body?.data?.records || [],
    token: body?.data?.paginationToken || null,
  };
}

async function fetchFloodAlerts({ date, walk = false } = {}) {
  let token = null;
  const records = [];
  const pages = walk ? 40 : 1;
  for (let i = 0; i < pages; i += 1) {
    const page = await fetchFloodPage({ date, paginationToken: token });
    records.push(...page.records);
    token = page.token;
    if (!token) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const alerts = records.filter((r) => (r.item?.readings || []).length > 0);
  return { records, alerts, heartbeats: records.length - alerts.length };
}

function printAlert(rec) {
  const item = rec.item || {};
  for (const reading of item.readings || []) {
    const area = reading.area || {};
    const circle = area.circle || [];
    console.log('---');
    console.log(`time     ${rec.datetime}`);
    console.log(`msgType  ${item.msgType || '?'}  severity ${reading.severity || '?'}  certainty ${reading.certainty || '?'}`);
    console.log(`headline ${reading.headline || ''}`);
    console.log(`area     ${area.areaDesc || ''}`);
    if (circle.length >= 3) console.log(`circle   lat=${circle[0]} lng=${circle[1]} r=${circle[2]}km (broadcast radius, not flood extent)`);
    console.log(`desc     ${(reading.description || '').replace(/\s+/g, ' ').trim()}`);
    console.log(`action   ${reading.instruction || ''}`);
    if (reading.expires) console.log(`expires  ${reading.expires}`);
    if (item.identifier) console.log(`id       ${item.identifier}`);
    if (item.msgType === 'Cancel' || item.references) console.log(`refs     ${item.references || ''}`);
  }
}

function printRain(rain, limit = 10) {
  console.log(`rain     ${rain.timestamp}  ${rain.type}`);
  console.log(`wet      ${rain.wet.length}/${rain.rows.length} stations (>=${WET_MM}mm / 5min), max ${rain.max}mm`);
  for (const r of rain.rows.slice(0, limit)) {
    if (r.mm <= 0) break;
    console.log(`  ${r.id.padEnd(5)} ${r.mm.toFixed(1).padStart(5)}  ${r.name}`);
  }
}

function isRaining(rain) {
  return rain.wet.length >= WET_STATIONS || rain.max >= 2;
}

async function once({ force, date, walk, json }) {
  const rain = await fetchRain();
  const raining = isRaining(rain);
  const flood = await fetchFloodAlerts({ date, walk: walk || Boolean(date) });
  const interesting = raining || force || flood.alerts.length > 0 || Boolean(date);

  if (json) {
    console.log(JSON.stringify({ raining, rain, flood }, null, 2));
    return { raining, rain, flood, interesting };
  }

  console.log(
    `flood-probe ${new Date().toISOString()}  raining=${raining}  heartbeats=${flood.heartbeats}  alerts=${flood.alerts.length}`,
  );
  if (!interesting) {
    console.log('dry and quiet — pass --force for full dump, or run again when raining');
    return { raining, rain, flood, interesting };
  }
  printRain(rain);
  if (flood.alerts.length === 0) {
    console.log('flood    no populated readings (empty heartbeats only)');
  } else {
    console.log(`flood    ${flood.alerts.length} populated record(s)`);
    for (const rec of flood.alerts) printAlert(rec);
  }
  return { raining, rain, flood, interesting };
}

const force = flag('--force');
const json = flag('--json');
const walk = flag('--walk');
const watch = flag('--watch');
const date = opt('--date');

if (watch) {
  for (;;) {
    try {
      const r = await once({ force, date, walk, json });
      // Keep watching only while there is something worth looking at.
      if (!r.raining && r.flood.alerts.length === 0 && !force) {
        console.log('watch: quiet — exiting (rerun when rain starts, or use --force)');
        break;
      }
    } catch (err) {
      console.error(err.rateLimited ? `rate limited: ${err.message}` : err);
    }
    console.log('');
    await new Promise((r) => setTimeout(r, 30_000));
  }
} else {
  try {
    await once({ force, date, walk, json });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
