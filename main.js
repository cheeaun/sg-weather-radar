import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(workerUrl);
const API_BASE = '/api';
const apiURL = (path, params = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) q.set(k, v);
  const s = q.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ''}`;
};
const SG_CENTER = [103.85, 1.29];
const SG_LAND_BOUNDS = [
  [103.60535, 1.21013],
  [104.04367, 1.47085],
];
const POLL_INTERVAL = 30 * 1000;
const PAST_HOURS = 1;
const RANGES = [480, 240, 70];
const SLOT_MS = 5 * 60 * 1000;
const FETCH_PAD_MS = SLOT_MS * 3;
const TICK_RANGES = [480, 240, 70];
const LIGHTNING_MAX_AGE = 10 * 60 * 1000;

const THEME_STORAGE_KEY = 'sgwr-theme';
const OPACITY_STORAGE_KEY = 'sgwr-radar-opacity';
const CLIP_STORAGE_KEY = 'sgwr-radar-clip';
const LIGHTNING_STORAGE_KEY = 'sgwr-lightning';
const WIND_STORAGE_KEY = 'sgwr-wind';
const API_CACHE_PREFIX = 'sgwr-api:';
const API_CACHE_TTL = 60 * 1000;
const FETCH_RETRIES = 2;
const FETCH_RETRY_DELAY = 1000;
const FETCH_TIMEOUT = 10 * 1000;
const RADAR_BOUNDS = {
  480: {
    upperLeft: { longitude: 99.638609, latitude: 5.657912 },
    lowerRight: { longitude: 108.290871, latitude: -2.967382 },
  },
  240: {
    upperLeft: { longitude: 101.810507, latitude: 3.506012 },
    lowerRight: { longitude: 106.130495, latitude: -0.809711 },
  },
  70: {
    upperLeft: { longitude: 103.342685, latitude: 1.97854 },
    lowerRight: { longitude: 104.602315, latitude: 0.719515 },
  },
};
const apiCacheStore = sessionStorage;
const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';

let map,
  styleReady = false,
  currentIndex = 0;
let pinnedSlot = null;
let refreshTimer = null;
let nextFetchAt = Date.now() + SLOT_MS;
let pollRanges = [];
let pollSlotMs = 0;
let boundaryBoxes = {};
let framesByRange = {};
let framesMap = {};
let allTimestamps = [];
let lastRadarSignature = null;
let themePreference = localStorage.getItem(THEME_STORAGE_KEY) || 'system';
let appliedStyle = null;
const darkModeQuery = matchMedia('(prefers-color-scheme: dark)');

let radarOpacity = clamp(parseFloat(localStorage.getItem(OPACITY_STORAGE_KEY)), 0.1, 1) || 0.75;
let clipBoundaries = localStorage.getItem(CLIP_STORAGE_KEY) !== 'off';
let showLightning = localStorage.getItem(LIGHTNING_STORAGE_KEY) === 'on';
let showWind = localStorage.getItem(WIND_STORAGE_KEY) === 'on';
let lightningStrikes = [];
let lightningLoading = null;
const failedImages = new Set();

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function slotOf(iso) {
  return Math.floor(new Date(iso).getTime() / SLOT_MS) * SLOT_MS;
}

function rangeShapeSVG(range) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><use href="#range-shape-${range}"/></svg>`;
}

function showError(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show', 'error');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('show', 'error'), 8000);
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  el.classList.remove('error');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

const BUSY_SHOW_DELAY = 150;
let busyCount = 0;
let busyShowTimer = null;

// The donut is the global busy indicator: metadata fetches, radar image loads and
// wind data all hold it. The delay keeps instant cache hits from flashing the spinner.
function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const el = document.getElementById('refresh-donut');
  if (busyCount > 0) {
    if (!busyShowTimer && !el.classList.contains('loading')) {
      busyShowTimer = setTimeout(() => {
        busyShowTimer = null;
        if (busyCount > 0) {
          el.querySelector('.donut-progress').style.animationDuration = '0.8s';
          el.querySelector('.donut-value').textContent = '…';
          el.setAttribute('title', 'Loading…');
          el.setAttribute('aria-label', 'Loading…');
          el.classList.add('loading');
        }
      }, BUSY_SHOW_DELAY);
    }
  } else if (busyShowTimer || el.classList.contains('loading')) {
    clearTimeout(busyShowTimer);
    busyShowTimer = null;
    el.classList.remove('loading');
    restartCountdown();
    tickCountdown();
  }
}

// Constructed once: building formatters with a timeZone is far too costly per scrub event.
const timeFormatter = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Singapore',
});
const dateFormatter = new Intl.DateTimeFormat('en-SG', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'Asia/Singapore',
});

function formatTime(iso) {
  const parts = timeFormatter.formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === 'hour').value;
  const minute = parts.find((p) => p.type === 'minute').value;
  const dayPeriod = parts.find((p) => p.type === 'dayPeriod').value.toLowerCase();
  return `${hour}.${minute} ${dayPeriod}`;
}

function formatDate(iso) {
  return dateFormatter.format(new Date(iso));
}

function sgtNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Singapore' }));
}

function sgtToday() {
  const n = sgtNow();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function sgtDayOffset(days) {
  const n = new Date(sgtNow().getTime() - days * 24 * 60 * 60 * 1000);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function panelControl(selector) {
  return {
    onAdd() {
      return document.querySelector(selector);
    },
    onRemove() {},
  };
}

const RANGE_TOGGLE_STATES = ['sg', 70, 240, 480];
const RANGE_TOGGLE_LABELS = { sg: 'Singapore', 70: '70 km', 240: '240 km', 480: '480 km' };

function fitToBounds(state, duration = 1000) {
  let bounds;
  if (state === 'sg') {
    bounds = SG_LAND_BOUNDS;
  } else {
    const bb = boundaryBoxes[state];
    if (!bb) return;
    bounds = [
      [bb.upperLeft.longitude, bb.lowerRight.latitude],
      [bb.lowerRight.longitude, bb.upperLeft.latitude],
    ];
  }
  const d = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration;
  map.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: d });
}

class RangeToggleControl {
  constructor() {
    this._index = 0;
  }
  onAdd(map) {
    this._map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group range-toggle-ctrl';
    const button = document.createElement('button');
    button.type = 'button';
    button.addEventListener('click', () => {
      this._index = (this._index + 1) % RANGE_TOGGLE_STATES.length;
      this._updateButton();
      this._fitBounds();
    });
    this._button = button;
    container.appendChild(button);
    this._container = container;
    this._updateButton();
    return container;
  }
  onRemove() {
    if (this._container) this._container.remove();
    this._container = undefined;
    this._map = undefined;
  }
  _updateButton() {
    const state = RANGE_TOGGLE_STATES[this._index];
    const label = RANGE_TOGGLE_LABELS[state];
    this._button.title = label;
    this._button.setAttribute('aria-label', `Fit map to ${label}`);
    this._button.innerHTML = `<svg${state === 'sg' ? ' class="sg-icon"' : ''} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><use href="#range-shape-${state}"/></svg>`;
  }
  _fitBounds() {
    fitToBounds(RANGE_TOGGLE_STATES[this._index]);
  }
}

class ClipToggleControl {
  onAdd(map) {
    this._map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle-btn';
    button.title = 'Clip intersecting radar at range boundaries';
    button.setAttribute('aria-label', 'Clip intersecting radar at range boundaries');
    button.setAttribute('aria-pressed', String(clipBoundaries));
    button.classList.toggle('toggle-active', clipBoundaries);
    button.innerHTML =
      '<svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 22a2 2 0 0 1-2-2"/><path d="M16 22h-2"/><path d="M16 4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3a1 1 0 0 0 1-1v-5a2 2 0 0 1 2-2h5a1 1 0 0 0 1-1z"/><path d="M20 8a2 2 0 0 1 2 2"/><path d="M22 14v2"/><path d="M22 20a2 2 0 0 1-2 2"/></svg>';
    button.addEventListener('click', () => {
      clipBoundaries = !clipBoundaries;
      localStorage.setItem(CLIP_STORAGE_KEY, clipBoundaries ? 'on' : 'off');
      button.classList.toggle('toggle-active', clipBoundaries);
      button.setAttribute('aria-pressed', String(clipBoundaries));
      showFrame(currentIndex);
      showToast(
        clipBoundaries ? 'Clipping radar at range boundaries' : 'Showing intersecting radar',
      );
    });
    container.appendChild(button);
    this._container = container;
    return container;
  }
  onRemove() {
    if (this._container) this._container.remove();
    this._container = undefined;
    this._map = undefined;
  }
}

class WindToggleControl {
  onAdd(map) {
    this._map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle-btn';
    button.title = 'Show wind flow';
    button.setAttribute('aria-label', 'Show wind flow');
    button.setAttribute('aria-pressed', String(showWind));
    button.classList.toggle('toggle-active', showWind);
    button.innerHTML =
      '<svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg>';
    button.addEventListener('click', () => {
      showWind = !showWind;
      localStorage.setItem(WIND_STORAGE_KEY, showWind ? 'on' : 'off');
      button.classList.toggle('toggle-active', showWind);
      button.setAttribute('aria-pressed', String(showWind));
      setWindOverlay(showWind);
      showToast(showWind ? 'Showing wind flow' : 'Hiding wind flow');
    });
    container.appendChild(button);
    this._container = container;
    return container;
  }
  onRemove() {
    if (this._container) this._container.remove();
    this._container = undefined;
    this._map = undefined;
  }
}

class LightningToggleControl {
  onAdd(map) {
    this._map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle-btn';
    button.title = 'Show cloud-to-ground lightning';
    button.setAttribute('aria-label', 'Show cloud-to-ground lightning');
    button.setAttribute('aria-pressed', String(showLightning));
    button.classList.toggle('toggle-active', showLightning);
    button.innerHTML =
      '<svg class="toggle-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
    button.addEventListener('click', () => {
      showLightning = !showLightning;
      localStorage.setItem(LIGHTNING_STORAGE_KEY, showLightning ? 'on' : 'off');
      button.classList.toggle('toggle-active', showLightning);
      button.setAttribute('aria-pressed', String(showLightning));
      renderLightning();
      refreshLightning();
      showToast(
        showLightning ? 'Showing cloud-to-ground lightning' : 'Hiding cloud-to-ground lightning',
      );
    });
    container.appendChild(button);
    this._container = container;
    return container;
  }
  onRemove() {
    if (this._container) this._container.remove();
    this._container = undefined;
    this._map = undefined;
  }
}

function resolvedTheme() {
  if (themePreference === 'system') return darkModeQuery.matches ? 'dark' : 'light';
  return themePreference;
}

function mapStyleForTheme(theme) {
  return theme === 'dark' ? STYLE_DARK : STYLE_LIGHT;
}

function updateThemeButtons() {
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    const active = btn.dataset.theme === themePreference;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function applyTheme() {
  const theme = resolvedTheme();
  const root = document.documentElement;
  if (themePreference === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  const style = mapStyleForTheme(theme);
  if (map && appliedStyle !== style) {
    appliedStyle = style;
    map.setStyle(style);
  }
  updateThemeButtons();
  if (showWind && windMotionQuery.matches) renderWindStatic();
}

function setThemePreference(pref) {
  if (!['system', 'light', 'dark'].includes(pref)) return;
  themePreference = pref;
  localStorage.setItem(THEME_STORAGE_KEY, pref);
  applyTheme();
}

function applyOpacity(value) {
  const v = clamp(value, 0.1, 1);
  radarOpacity = v;
  if (map) {
    for (const range of RANGES) {
      if (map.getLayer(`radar-${range}`)) {
        map.setPaintProperty(`radar-${range}`, 'raster-opacity', v);
      }
    }
  }
  document.getElementById('opacity-value').textContent = `${Math.round(v * 100)}%`;
  document.getElementById('opacity-reset').classList.toggle('visible', v !== 0.75);
}

const opacitySlider = document.getElementById('opacity-slider');
opacitySlider.addEventListener('input', (e) => {
  applyOpacity(parseFloat(e.target.value));
  localStorage.setItem(OPACITY_STORAGE_KEY, String(radarOpacity));
});
document.getElementById('opacity-reset').addEventListener('click', () => {
  opacitySlider.value = '0.75';
  applyOpacity(0.75);
  localStorage.setItem(OPACITY_STORAGE_KEY, '0.75');
});
applyOpacity(radarOpacity);

darkModeQuery.addEventListener('change', () => {
  if (themePreference === 'system') applyTheme();
});

document.querySelectorAll('.theme-btn').forEach((btn) => {
  btn.addEventListener('click', () => setThemePreference(btn.dataset.theme));
});

const settingsSheet = document.getElementById('settings-sheet');
const sheetBackdrop = document.getElementById('sheet-backdrop');
const sheetClose = document.getElementById('sheet-close');
const settingsBtn = document.getElementById('settings-btn');

function openSettingsSheet() {
  settingsSheet.classList.add('open');
  sheetBackdrop.classList.add('open');
  settingsSheet.setAttribute('aria-hidden', 'false');
  document.body.classList.add('sheet-open');
  sheetClose.focus();
}

function closeSettingsSheet() {
  settingsSheet.classList.remove('open');
  sheetBackdrop.classList.remove('open');
  settingsSheet.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('sheet-open');
  settingsBtn.focus();
}

settingsBtn.querySelector('.settings-gear').addEventListener('click', openSettingsSheet);
sheetClose.addEventListener('click', closeSettingsSheet);
sheetBackdrop.addEventListener('click', closeSettingsSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsSheet.classList.contains('open')) closeSettingsSheet();
});

function initMap() {
  appliedStyle = mapStyleForTheme(resolvedTheme());
  map = new maplibregl.Map({
    container: 'map',
    style: appliedStyle,
    center: SG_CENTER,
    zoom: 8,
    attributionControl: {
      compact: true,
      customAttribution:
        'Weather data © <a href="https://data.gov.sg/open-data-licence" target="_blank" rel="noopener">NEA, data.gov.sg</a>',
    },
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new RangeToggleControl(), 'bottom-right');
  map.addControl(new ClipToggleControl(), 'bottom-right');
  map.addControl(new WindToggleControl(), 'bottom-right');
  map.addControl(new LightningToggleControl(), 'bottom-right');
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    }),
    'bottom-right',
  );
  map.addControl(panelControl('.masthead'), 'top-left');
  map.addControl(panelControl('.console'), 'bottom-left');
  map.addControl(panelControl('.settings-btn'), 'top-right');
  fitToBounds('sg', 0);
  // Radar data fetch starts immediately at module init; only wind needs the loaded map.
  map.once('load', () => {
    if (showWind) setWindOverlay(true);
  });
  map.on('move', windInvalidateScreen);
  map.on('moveend', () => {
    if (!showWind) return;
    if (windMotionQuery.matches) renderWindStatic();
    else respawnAllWind();
  });
  map.on('style.load', () => {
    styleReady = true;
    addRadarLayers();
    addLandOutline();
    addWindLayer();
    addBoundaryLayers();
    addLightningLayer();
    raisePlaceLabels();
  });
  applyTheme();
}

function apiCacheKey(url) {
  return API_CACHE_PREFIX + url;
}

let lastPruneAt = 0;

function pruneApiCache(now = Date.now()) {
  try {
    const doomed = [];
    for (let i = 0; i < apiCacheStore.length; i++) {
      const key = apiCacheStore.key(i);
      if (!key || !key.startsWith(API_CACHE_PREFIX)) continue;
      let expired = true;
      try {
        const entry = JSON.parse(apiCacheStore.getItem(key));
        expired = !entry || now - entry.cachedAt >= API_CACHE_TTL;
      } catch (e) {}
      if (expired) doomed.push(key);
    }
    for (const key of doomed) apiCacheStore.removeItem(key);
    lastPruneAt = now;
  } catch (e) {}
}

function readApiCache(url) {
  try {
    const raw = apiCacheStore.getItem(apiCacheKey(url));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry && typeof entry.data === 'object') return entry;
  } catch (e) {}
  return null;
}

function writeApiCache(url, data) {
  try {
    apiCacheStore.setItem(apiCacheKey(url), JSON.stringify({ cachedAt: Date.now(), data }));
    // Pruning JSON.parses every cached response; don't do that per write.
    if (Date.now() - lastPruneAt >= API_CACHE_TTL) pruneApiCache();
  } catch (e) {
    try {
      apiCacheStore.removeItem(apiCacheKey(url));
    } catch (_) {}
    pruneApiCache();
  }
}

const inflightFetches = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertApiOk(json, url) {
  if (!json || json.code !== 0) {
    throw new Error(`${json ? json.errorMsg || `code ${json.code}` : 'empty response'} [${url}]`);
  }
}

async function httpErrorMessage(res, url) {
  let msg = `API ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  try {
    const body = await res.text();
    if (body) {
      try {
        const json = JSON.parse(body);
        msg += `: ${json.errorMsg || json.error || (json.code != null ? `code ${json.code}` : body.slice(0, 120))}`;
      } catch {
        msg += `: ${body.slice(0, 120)}`;
      }
    }
  } catch {}
  return `${msg} [${url}]`;
}

async function fetchWithRetry(url, cached) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (res.status === 409 && cached) return cached.data;
      if (res.ok) return await res.json();
    } catch (e) {
      if (cached) return cached.data;
      if (attempt > FETCH_RETRIES) throw new Error(`${e.message || 'fetch failed'} [${url}]`);
      await delay(FETCH_RETRY_DELAY);
      continue;
    }
    if (cached) return cached.data;
    if (attempt <= FETCH_RETRIES) {
      await delay(FETCH_RETRY_DELAY);
      continue;
    }
    throw new Error(await httpErrorMessage(res, url));
  }
}

async function fetchJsonCached(url) {
  if (inflightFetches.has(url)) return inflightFetches.get(url);
  const promise = (async () => {
    const cached = readApiCache(url);
    if (cached && Date.now() - cached.cachedAt < API_CACHE_TTL) return cached.data;

    const json = await fetchWithRetry(url, cached);
    writeApiCache(url, json);
    return json;
  })();
  inflightFetches.set(url, promise);
  try {
    return await promise;
  } finally {
    inflightFetches.delete(url);
  }
}

async function fetchBypassCache(url) {
  if (inflightFetches.has(url)) return inflightFetches.get(url);
  const promise = (async () => {
    const cached = readApiCache(url);
    const json = await fetchWithRetry(url, cached);
    writeApiCache(url, json);
    return json;
  })();
  inflightFetches.set(url, promise);
  try {
    return await promise;
  } finally {
    inflightFetches.delete(url);
  }
}

async function fetchDayForRange(range, dateStr, paginationToken, fetchFn = fetchJsonCached) {
  const url = apiURL(`/weather-radar-images/${range}km`, { date: dateStr, paginationToken });
  const json = await fetchFn(url);
  assertApiOk(json, url);
  return json;
}

async function fetchLightningDay(dateStr, paginationToken, fetchFn = fetchJsonCached) {
  const url = apiURL('/weather', { api: 'lightning', date: dateStr, paginationToken });
  const json = await fetchFn(url);
  assertApiOk(json, url);
  return json;
}

async function loadLightningData(fetchFn) {
  const now = sgtNow();
  const cutoff = new Date(now.getTime() - PAST_HOURS * 60 * 60 * 1000);
  const today = sgtToday();
  const dateStrs = [today];
  if (cutoff < new Date(`${today}T00:00:00`)) dateStrs.unshift(sgtDayOffset(1));
  const strikes = [];

  for (const dateStr of dateStrs) {
    let token = null;
    let keepPaginating = true;

    while (keepPaginating) {
      const json = await fetchLightningDay(dateStr, token, fetchFn);
      const data = json.data;
      const recs = data.records || [];
      for (const rec of recs) {
        for (const reading of rec.item.readings || []) {
          if (reading.type !== 'G') continue;
          const t = new Date(reading.datetime).getTime();
          if (t < cutoff.getTime()) continue;
          strikes.push({
            lat: parseFloat(reading.location.latitude),
            lng: parseFloat(reading.location.longitude),
            t,
          });
        }
      }
      token = data.paginationToken;
      const oldest = recs.length ? new Date(recs[recs.length - 1].datetime).getTime() : 0;
      if (!token || !recs.length || oldest < cutoff.getTime()) keepPaginating = false;
    }
  }

  return strikes.sort((a, b) => a.t - b.t);
}

async function refreshLightning() {
  if (!showLightning || lightningLoading) return;
  lightningLoading = loadLightningData(fetchJsonCached)
    .then((strikes) => {
      lightningStrikes = strikes;
      renderLightning();
    })
    .catch((e) => {
      console.error('Lightning fetch error:', e);
    })
    .finally(() => {
      lightningLoading = null;
    });
  return lightningLoading;
}

async function loadRadarData(fetchFn, ranges = RANGES) {
  const now = sgtNow();
  const cutoff = new Date(now.getTime() - PAST_HOURS * 60 * 60 * 1000 - FETCH_PAD_MS);
  const today = sgtToday();
  const dateStrs = [today];
  if (cutoff < new Date(`${today}T00:00:00`)) dateStrs.unshift(sgtDayOffset(1));
  const rangeResults = {};

  const results = await Promise.allSettled(
    ranges.map(async (range) => {
      try {
        let allRecords = [];
        let bb = null;

        for (const dateStr of dateStrs) {
          let token = null;
          let keepPaginating = true;

          while (keepPaginating) {
            const json = await fetchDayForRange(range, dateStr, token, fetchFn);
            const data = json.data;
            if (data.boundaryBox) bb = data.boundaryBox;
            const recs = data.records || [];
            allRecords = allRecords.concat(recs);
            token = data.paginationToken;
            if (!token || !recs.length || new Date(recs[recs.length - 1].timestamp) < cutoff) {
              keepPaginating = false;
            }
          }
        }

        return {
          range,
          bb,
          frames: allRecords
            .filter((r) => new Date(r.timestamp) >= cutoff && r.image && r.image.url)
            .map((r) => ({ url: r.image.url, timestamp: r.timestamp }))
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)),
        };
      } catch (e) {
        throw new Error(`Range ${range}km: ${e.message}`);
      }
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { range, bb, frames } = result.value;
      rangeResults[range] = { bb: bb || RADAR_BOUNDS[range], frames };
    } else {
      console.error(result.reason);
    }
  }

  if (!ranges.some((range) => rangeResults[range])) {
    throw new Error(
      results
        .map((r) => r.reason?.message)
        .filter(Boolean)
        .join('; '),
    );
  }

  if (ranges.length === RANGES.length) {
    for (const range of RANGES) {
      if (!rangeResults[range]) {
        rangeResults[range] = { bb: RADAR_BOUNDS[range], frames: [] };
      }
    }
  }

  return rangeResults;
}

function radarSignature() {
  return RANGES.map((range) => {
    const map = framesMap[range] || new Map();
    const slots = [...map.entries()].sort((a, b) => a[0] - b[0]);
    return `${range}:${slots.map(([t, f]) => `${t}:${f.url}`).join(',')}`;
  }).join('|');
}

function flashNewData() {
  const scanTime = document.getElementById('scan-time');
  scanTime.classList.remove('flash');
  void scanTime.offsetWidth;
  scanTime.classList.add('flash');
  clearTimeout(scanTime._flashTimer);
  scanTime._flashTimer = setTimeout(() => scanTime.classList.remove('flash'), 1300);
}

function rebuildTimeline() {
  const prevSlots = new Set();
  for (const t of allTimestamps) prevSlots.add(new Date(t).getTime());
  let oldestSlot = Infinity,
    maxSlot = -Infinity;
  for (const range of RANGES) {
    const map = framesMap[range];
    if (!map) continue;
    for (const t of map.keys()) {
      if (t < oldestSlot) oldestSlot = t;
      if (t > maxSlot) maxSlot = t;
    }
  }
  allTimestamps = [];
  if (oldestSlot <= maxSlot) {
    const minSlot = Math.max(oldestSlot, maxSlot - PAST_HOURS * 60 * 60 * 1000);
    for (let t = minSlot; t <= maxSlot; t += SLOT_MS) {
      allTimestamps.push(new Date(t).toISOString());
    }
  }
  const newSlots = new Set();
  for (const t of allTimestamps) {
    const slotMs = new Date(t).getTime();
    if (!prevSlots.has(slotMs)) newSlots.add(slotMs);
  }
  currentIndex = allTimestamps.length - 1;
  if (pinnedSlot !== null) {
    const idx = allTimestamps.findIndex((t) => new Date(t).getTime() === pinnedSlot);
    if (idx !== -1) currentIndex = idx;
    else pinnedSlot = null;
  }
  return newSlots;
}

function applyRadarData(rangeResults, strikes) {
  boundaryBoxes = {};
  framesByRange = {};
  framesMap = {};
  failedImages.clear();
  for (const range of RANGES) {
    const result = rangeResults[range];
    if (!result) continue;
    boundaryBoxes[range] = result.bb;
    framesByRange[range] = result.frames;
    const slots = new Map();
    for (const f of framesByRange[range]) {
      const slot = slotOf(f.timestamp);
      const existing = slots.get(slot);
      if (
        !existing ||
        Math.abs(new Date(f.timestamp) - slot) < Math.abs(new Date(existing.timestamp) - slot)
      ) {
        slots.set(slot, f);
      }
    }
    framesMap[range] = slots;
  }
  if (strikes) lightningStrikes = strikes;

  const newSlots = rebuildTimeline();
  addBoundaryLayers();
  updateSlider(newSlots);
  showFrame(currentIndex);

  const sig = radarSignature();
  if (lastRadarSignature !== null && sig !== lastRadarSignature) flashNewData();
  lastRadarSignature = sig;
}

function mergeRangeResults(rangeResults) {
  for (const range of RANGES) {
    const result = rangeResults[range];
    if (!result) continue;
    boundaryBoxes[range] = result.bb;
    framesByRange[range] = result.frames;
    const slots = new Map();
    for (const f of result.frames) {
      const slot = slotOf(f.timestamp);
      const existing = slots.get(slot);
      if (
        !existing ||
        Math.abs(new Date(f.timestamp) - slot) < Math.abs(new Date(existing.timestamp) - slot)
      ) {
        slots.set(slot, f);
      }
    }
    framesMap[range] = slots;
  }
  addBoundaryLayers();
  const newSlots = rebuildTimeline();
  updateSlider(newSlots);
  showFrame(currentIndex);
}

function hasNewerRadarData(rangeResults) {
  let latestNew = 0;
  for (const range of RANGES) {
    const frames = rangeResults[range]?.frames || [];
    if (frames.length)
      latestNew = Math.max(latestNew, new Date(frames[frames.length - 1].timestamp).getTime());
  }
  if (!latestNew) return false;
  const latestCur = allTimestamps.length
    ? new Date(allTimestamps[allTimestamps.length - 1]).getTime()
    : 0;
  return latestNew > latestCur;
}

let fetchRadarBusy = false;
let lastFetchStart = 0;

async function fetchRadar() {
  if (fetchRadarBusy) return;
  fetchRadarBusy = true;
  lastFetchStart = Date.now();
  try {
    await doFetchRadar();
  } finally {
    fetchRadarBusy = false;
  }
}

async function doFetchRadar() {
  setBusy(true);
  let rendered = false;
  // Cache miss returns an empty success so the best-effort first pass doesn't log errors
  const cacheMiss = { code: 0, data: { records: [] } };
  const cacheReader = (url) => readApiCache(url)?.data ?? cacheMiss;

  try {
    const [rangeResults, strikes] = await Promise.all([
      loadRadarData(cacheReader),
      showLightning ? loadLightningData(cacheReader).catch(() => null) : null,
    ]);
    if (RANGES.some((range) => rangeResults[range]?.frames.length)) {
      applyRadarData(rangeResults, strikes);
      rendered = true;
    }
  } catch (e) {}

  try {
    const [rangeResults, strikes] = await Promise.all([
      loadRadarData(fetchBypassCache),
      showLightning
        ? loadLightningData(fetchBypassCache).catch((e) => {
            console.error('Lightning fetch error:', e);
          })
        : null,
    ]);
    if (!rendered || hasNewerRadarData(rangeResults)) {
      applyRadarData(rangeResults, strikes);
    }
  } catch (e) {
    if (!rendered) {
      console.error('Fetch error:', e);
      showError(`Failed to load radar data: ${e.message}`);
    }
  } finally {
    setBusy(false);
  }
}

function missingRangesFor(slotMs) {
  return RANGES.filter((range) => !framesMap[range]?.get(slotMs));
}

async function fetchAtSlot() {
  if (fetchRadarBusy) {
    scheduleNextRefresh();
    return;
  }
  pollSlotMs = slotOf(new Date());
  pollRanges = [];
  await fetchRadar();
  pollRanges = missingRangesFor(pollSlotMs);
  if (showWind) loadWind();
  scheduleNextRefresh();
}

async function pollOnce() {
  if (Date.now() >= pollSlotMs + SLOT_MS) {
    await fetchAtSlot();
    return;
  }
  if (fetchRadarBusy || document.visibilityState === 'hidden' || !pollRanges.length) {
    scheduleNextRefresh();
    return;
  }
  const ranges = pollRanges;
  const slot = pollSlotMs;
  fetchRadarBusy = true;
  lastFetchStart = Date.now();
  setBusy(true);
  try {
    const rangeResults = await loadRadarData(fetchBypassCache, ranges);
    mergeRangeResults(rangeResults);
  } catch (e) {
    console.error('Poll fetch error:', e);
  } finally {
    fetchRadarBusy = false;
    setBusy(false);
  }
  pollRanges = missingRangesFor(slot);
  if (!pollRanges.length) flashNewData();
  scheduleNextRefresh();
}

function scheduleNextRefresh() {
  clearTimeout(refreshTimer);
  const nextSlot = Math.floor(Date.now() / SLOT_MS) * SLOT_MS + SLOT_MS;
  let delay;
  if (pollRanges.length) {
    delay = Math.min(POLL_INTERVAL, nextSlot - Date.now());
  } else {
    delay = nextSlot - Date.now();
  }
  if (delay <= 0) {
    nextFetchAt = nextSlot;
    refreshTimer = setTimeout(fetchAtSlot, 0);
  } else {
    nextFetchAt = Date.now() + delay;
    refreshTimer = setTimeout(pollRanges.length ? pollOnce : fetchAtSlot, delay);
  }
  restartCountdown();
}

let tickMidpoints = [];

function computeTickMidpoints() {
  const cols = document.getElementById('slider-ticks').children;
  const rects = [];
  for (let i = 0; i < cols.length; i++) rects.push(cols[i].getBoundingClientRect());
  tickMidpoints = [];
  for (let i = 1; i < rects.length; i++) {
    tickMidpoints.push(
      (rects[i - 1].left + rects[i - 1].width / 2 + rects[i].left + rects[i].width / 2) / 2,
    );
  }
}

function renderTicks(newSlots) {
  const container = document.getElementById('slider-ticks');
  container.replaceChildren();
  const n = allTimestamps.length;
  for (let i = 0; i < n; i++) {
    const col = document.createElement('div');
    col.className = 'tick-col';
    const slotMs = new Date(allTimestamps[i]).getTime();
    for (const range of TICK_RANGES) {
      const shape = document.createElement('span');
      shape.className = 'tick-shape';
      shape.innerHTML = rangeShapeSVG(range);
      const frame = framesMap[range]?.get(slotMs);
      if (frame && !failedImages.has(frame.url)) shape.classList.add('on');
      col.appendChild(shape);
    }
    if (newSlots && newSlots.has(slotMs)) col.classList.add('new');
    container.appendChild(col);
  }
  computeTickMidpoints();
}

function updateSlider(newSlots) {
  const slider = document.getElementById('time-slider');
  slider.max = Math.max(0, allTimestamps.length - 1);
  document.getElementById('time-oldest').textContent = allTimestamps.length
    ? formatTime(allTimestamps[0])
    : '--:--';
  document.getElementById('time-latest').textContent = allTimestamps.length
    ? formatTime(allTimestamps[allTimestamps.length - 1])
    : '--:--';
  renderTicks(newSlots);
  updateSliderUI(currentIndex);
}

function updateSliderUI(index) {
  const slider = document.getElementById('time-slider');
  slider.value = index;

  const tickCols = document.getElementById('slider-ticks').children;
  for (let i = 0; i < tickCols.length; i++) tickCols[i].classList.toggle('active', i === index);

  const ts = allTimestamps[index];
  document.getElementById('scan-time').textContent = ts ? formatTime(ts) : '--:--';
  document.getElementById('scan-date').textContent = ts ? formatDate(ts) : '--';
}

const RADAR_BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const CLIP_SOURCE = { 480: 240, 240: 70 };
const frameImageCache = new Map();
const FRAME_CACHE_MAX = 24;
const radarShownKey = new Map();

function bbCoordinatesOf(bb) {
  return [
    [bb.upperLeft.longitude, bb.upperLeft.latitude],
    [bb.lowerRight.longitude, bb.upperLeft.latitude],
    [bb.lowerRight.longitude, bb.lowerRight.latitude],
    [bb.upperLeft.longitude, bb.lowerRight.latitude],
  ];
}

function addRadarLayers() {
  if (!map || !styleReady) return;
  radarShownKey.clear();
  for (const range of RANGES) {
    if (map.getSource(`radar-${range}`)) continue;
    map.addSource(`radar-${range}`, {
      type: 'image',
      url: RADAR_BLANK_PNG,
      coordinates: bbCoordinatesOf(boundaryBoxes[range] || RADAR_BOUNDS[range]),
    });
    map.addLayer({
      id: `radar-${range}`,
      type: 'raster',
      source: `radar-${range}`,
      paint: {
        'raster-opacity': radarOpacity,
        resampling: 'nearest',
        'raster-fade-duration': 0,
      },
    });
  }
  if (allTimestamps.length) showFrame(currentIndex);
}

// Coastline traced above the radar so rain stays readable against the land it falls on.
// Inland water edges only join at close zooms, where their detail stops being noise.
function addLandOutline() {
  if (!map || !styleReady) return;
  if (!map.getSource('openmaptiles')) return;
  const specs = [
    { id: LAND_OUTLINE_LAYER_ID, filter: ['==', ['get', 'class'], 'ocean'] },
    {
      id: LAND_OUTLINE_INLAND_LAYER_ID,
      minzoom: 12,
      filter: ['in', ['get', 'class'], ['literal', ['lake', 'pond', 'river', 'canal']]],
    },
  ];
  for (const { id, filter, minzoom } of specs) {
    if (map.getLayer(id)) map.removeLayer(id);
    map.addLayer({
      id,
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'water',
      ...(minzoom ? { minzoom } : {}),
      filter,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': landOutlineColor(),
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 12, 1.6],
      },
    });
  }
}

// Base-style place labels sit under the overlays; raise them so names stay readable over rain.
function raisePlaceLabels() {
  if (!map || !styleReady) return;
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'symbol' && layer['source-layer'] === 'place') map.moveLayer(layer.id);
  }
}

function mercatorY(lat) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
}

function mercatorLat(y) {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

async function fetchRadarImage(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (res.ok) return await res.blob();
    } catch (e) {}
    if (attempt >= FETCH_RETRIES) throw new Error(`Radar image failed [${url}]`);
    await delay(FETCH_RETRY_DELAY);
  }
}

// Source rows are evenly spaced in latitude but the map stretches the texture evenly
// in Mercator Y, so resample row by row to land every radar pixel in its true place.
function buildRadarCanvas(range, frame, clip) {
  return fetchRadarImage(frame.url).then((blob) =>
    createImageBitmap(blob).then((bitmap) => {
      try {
        const bb = boundaryBoxes[range] || RADAR_BOUNDS[range];
        const W = bitmap.width;
        const H = bitmap.height;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        const yTop = mercatorY(bb.upperLeft.latitude);
        const yBot = mercatorY(bb.lowerRight.latitude);
        const latSpan = bb.upperLeft.latitude - bb.lowerRight.latitude;
        // Pixel-center latitude of each output row (rows are evenly spaced in Mercator Y).
        const rowLat = new Float64Array(H);
        for (let y = 0; y < H; y++) {
          const lat = mercatorLat(yTop + ((y + 0.5) / H) * (yBot - yTop));
          rowLat[y] = lat;
          const srcY = clamp(((bb.upperLeft.latitude - lat) / latSpan) * H - 0.5, 0, H - 1);
          ctx.drawImage(bitmap, 0, srcY, W, 1, 0, y, W, 1);
        }
        const innerRange = CLIP_SOURCE[range];
        if (clip && innerRange) {
          const inner = boundaryBoxes[innerRange] || RADAR_BOUNDS[innerRange];
          const lonSpan = bb.lowerRight.longitude - bb.upperLeft.longitude;
          // Shrink the target box inward by half an outer texel before selecting pixels to
          // clear. Without this, texel-center quantization can push the hole edge a sliver
          // *outside* the inner box, leaving a hairline base-map seam at the boundary. The
          // eroded hole is always strictly covered by the inner image (whose map-drawn edge
          // is sub-pixel exact), so the visible outer->inner edge is sub-pixel accurate.
          const west = inner.upperLeft.longitude + lonSpan / W / 2;
          const east = inner.lowerRight.longitude - lonSpan / W / 2;
          const halfRow = (yTop - yBot) / H / 2;
          const north = mercatorLat(mercatorY(inner.upperLeft.latitude) - halfRow);
          const south = mercatorLat(mercatorY(inner.lowerRight.latitude) + halfRow);
          let x0 = W,
            x1 = -1;
          for (let x = 0; x < W; x++) {
            const lon = bb.upperLeft.longitude + ((x + 0.5) / W) * lonSpan;
            if (lon >= west && lon <= east) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
            }
          }
          let y0 = H,
            y1 = -1;
          for (let y = 0; y < H; y++) {
            if (rowLat[y] <= north && rowLat[y] >= south) {
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
          if (x1 >= x0 && y1 >= y0) ctx.clearRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
        }
        return canvas;
      } finally {
        bitmap.close();
      }
    }),
  );
}

function frameImageKey(frame, clip) {
  return clip ? `${frame.url}#clip` : frame.url;
}

function prepareFrameImage(range, frame) {
  const key = frameImageKey(frame, clipBoundaries);
  let promise = frameImageCache.get(key);
  if (!promise) {
    promise = buildRadarCanvas(range, frame, clipBoundaries).catch((e) => {
      frameImageCache.delete(key);
      throw e;
    });
    frameImageCache.set(key, promise);
    while (frameImageCache.size > FRAME_CACHE_MAX) {
      frameImageCache.delete(frameImageCache.keys().next().value);
    }
  }
  frameImageCache.delete(key);
  frameImageCache.set(key, promise);
  return promise;
}

function applyRadarFrame(range, frame) {
  const source = map && styleReady && map.getSource(`radar-${range}`);
  if (!source) return;
  if (!frame || failedImages.has(frame.url)) {
    radarShownKey.delete(range);
    map.setLayoutProperty(`radar-${range}`, 'visibility', 'none');
    return;
  }
  map.setLayoutProperty(`radar-${range}`, 'visibility', 'visible');
  source.setCoordinates(bbCoordinatesOf(boundaryBoxes[range] || RADAR_BOUNDS[range]));
  const key = frameImageKey(frame, clipBoundaries);
  if (radarShownKey.get(range) === key) return;
  radarShownKey.set(range, key);
  setBusy(true);
  prepareFrameImage(range, frame)
    .then((canvas) => {
      const src = styleReady && map.getSource(`radar-${range}`);
      if (!src || radarShownKey.get(range) !== key) return;
      src.updateImage({ image: canvas });
    })
    .catch(() => {
      if (!failedImages.has(frame.url)) {
        failedImages.add(frame.url);
        renderTicks();
        updateBoundaryAvailability();
      }
      if (radarShownKey.get(range) === key) {
        radarShownKey.delete(range);
        if (map.getLayer(`radar-${range}`)) {
          map.setLayoutProperty(`radar-${range}`, 'visibility', 'none');
        }
      }
    })
    .finally(() => setBusy(false));
}

function boundaryOutlineColor() {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--radar-outline').trim() ||
    'rgba(0, 0, 0, 0.4)'
  );
}

function landOutlineColor() {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--land-outline').trim() ||
    'rgba(52, 66, 74, 0.6)'
  );
}

function boundaryTextColor() {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--ink-strong').trim() || '#0a161c'
  );
}

function boundaryTextHalo() {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--shape-halo').trim() ||
    'rgba(253, 252, 248, 0.95)'
  );
}

const SHAPE_SIZE = 12;
const SHAPE_SCALE = 2;
const SHAPE_VARIANTS = {
  light: { ink: '#0a161c', halo: 'rgba(253, 252, 248, 0.95)' },
  dark: { ink: '#eef4f6', halo: 'rgba(5, 9, 11, 0.95)' },
};

function traceShape(ctx, range, cx, cy) {
  ctx.beginPath();
  switch (range) {
    case 70:
      ctx.moveTo(cx, cy - 5.4);
      ctx.lineTo(cx + 5.5, cy + 5.4);
      ctx.lineTo(cx - 5.5, cy + 5.4);
      ctx.closePath();
      break;
    case 240:
      ctx.rect(cx - 3.5, cy - 3.5, 7, 7);
      break;
    case 480:
      ctx.moveTo(cx, cy - 4);
      ctx.lineTo(cx + 4, cy);
      ctx.lineTo(cx, cy + 4);
      ctx.lineTo(cx - 4, cy);
      ctx.closePath();
      break;
  }
}

function renderShapeImage(range, variant) {
  const { ink, halo } = SHAPE_VARIANTS[variant];
  const canvas = document.createElement('canvas');
  canvas.width = SHAPE_SIZE * SHAPE_SCALE;
  canvas.height = SHAPE_SIZE * SHAPE_SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SHAPE_SCALE, SHAPE_SCALE);
  const cx = SHAPE_SIZE / 2;
  const cy = SHAPE_SIZE / 2;

  ctx.save();
  ctx.strokeStyle = halo;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = halo;
  ctx.shadowBlur = 2;
  traceShape(ctx, range, cx, cy);
  ctx.stroke();
  ctx.restore();

  traceShape(ctx, range, cx, cy);
  ctx.fillStyle = ink;
  ctx.fill();

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

const shapeImagePromises = new Map();

function ensureRangeShapes() {
  for (const variant of Object.keys(SHAPE_VARIANTS)) {
    for (const range of RANGES) {
      const name = `radar-shape-${variant}-${range}`;
      if (map.hasImage(name)) continue;
      const p = Promise.resolve().then(() => {
        const imageData = renderShapeImage(range, variant);
        if (imageData && !map.hasImage(name)) {
          try {
            map.addImage(name, imageData, { pixelRatio: SHAPE_SCALE });
          } catch (e) {}
        }
      });
      shapeImagePromises.set(name, p);
    }
  }
  return Promise.all([...shapeImagePromises.values()]);
}

function circlePolygon(lon, lat, radiusKm, steps = 180) {
  const coords = [];
  const rad = Math.PI / 180;
  const d = radiusKm / 6371;
  for (let i = 0; i <= steps; i++) {
    const brg = (i / steps) * 2 * Math.PI;
    const la = Math.asin(
      Math.sin(lat * rad) * Math.cos(d) + Math.cos(lat * rad) * Math.sin(d) * Math.cos(brg),
    );
    const lo =
      lon +
      Math.atan2(
        Math.sin(brg) * Math.sin(d) * Math.cos(lat * rad),
        Math.cos(d) - Math.sin(lat * rad) * Math.sin(la),
      ) /
        rad;
    coords.push([lo, la / rad]);
  }
  return { type: 'Polygon', coordinates: [coords] };
}

function addBoundaryLayers() {
  // map.addSource/addImage throw before the style exists; style.load re-invokes this.
  if (!map || !styleReady) return;
  const features = [];
  const labelFeatures = [];
  const circleFeatures = [];
  for (const range of RANGES) {
    const bb = boundaryBoxes[range];
    if (!bb) continue;
    features.push({
      type: 'Feature',
      id: range,
      properties: { range },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [bb.upperLeft.longitude, bb.upperLeft.latitude],
            [bb.lowerRight.longitude, bb.upperLeft.latitude],
            [bb.lowerRight.longitude, bb.lowerRight.latitude],
            [bb.upperLeft.longitude, bb.lowerRight.latitude],
            [bb.upperLeft.longitude, bb.upperLeft.latitude],
          ],
        ],
      },
    });
    labelFeatures.push({
      type: 'Feature',
      id: range,
      properties: { range: String(range), label: `${range}km` },
      geometry: {
        type: 'Point',
        coordinates: [
          (bb.upperLeft.longitude + bb.lowerRight.longitude) / 2,
          bb.upperLeft.latitude,
        ],
      },
    });
    circleFeatures.push({
      type: 'Feature',
      id: range,
      properties: { range },
      geometry: circlePolygon(
        (bb.upperLeft.longitude + bb.lowerRight.longitude) / 2,
        (bb.upperLeft.latitude + bb.lowerRight.latitude) / 2,
        range,
      ),
    });
  }
  if (!features.length) return;
  if (map.getSource('radar-boundaries')) {
    map.getSource('radar-boundaries').setData({ type: 'FeatureCollection', features });
    map
      .getSource('radar-boundary-labels')
      .setData({ type: 'FeatureCollection', features: labelFeatures });
    map
      .getSource('radar-boundary-circles')
      .setData({ type: 'FeatureCollection', features: circleFeatures });
    updateBoundaryAvailability();
    return;
  }
  ensureRangeShapes().then(() => {
    if (!map || map.getSource('radar-boundaries')) return;
    map.addSource('radar-boundaries', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features },
    });
    const BOUNDARY_DASHES = { 70: [1, 2], 240: [2, 3], 480: [4, 5] };
    for (const range of RANGES) {
      map.addLayer({
        id: `radar-boundary-line-${range}`,
        type: 'line',
        source: 'radar-boundaries',
        filter: ['==', ['get', 'range'], range],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': boundaryOutlineColor(),
          'line-width': 1.5,
          'line-dasharray': BOUNDARY_DASHES[range],
          'line-opacity': ['case', ['boolean', ['feature-state', 'available'], true], 1, 0.25],
        },
      });
    }
    map.addSource('radar-boundary-circles', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: circleFeatures },
    });
    for (const range of RANGES) {
      map.addLayer({
        id: `radar-boundary-circle-${range}`,
        type: 'line',
        source: 'radar-boundary-circles',
        filter: ['==', ['get', 'range'], range],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': boundaryOutlineColor(),
          'line-width': 1.5,
          'line-dasharray': BOUNDARY_DASHES[range],
          'line-opacity': ['case', ['boolean', ['feature-state', 'available'], true], 0.5, 0.125],
        },
      });
    }
    map.addSource('radar-boundary-labels', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: labelFeatures },
    });
    map.addLayer({
      id: 'radar-boundary-label',
      type: 'symbol',
      source: 'radar-boundary-labels',
      layout: {
        'text-field': [
          'format',
          ['image', ['concat', `radar-shape-${resolvedTheme()}-`, ['get', 'range']]],
          {},
          ' ',
          {},
          ['get', 'label'],
          {},
        ],
        'text-font': ['Noto Sans Bold'],
        'text-size': 11,
        'text-anchor': 'center',
        'text-offset': [0, 0.9],
        'text-allow-overlap': true,
      },
      paint: {
        'text-color': boundaryTextColor(),
        'text-halo-color': boundaryTextHalo(),
        'text-halo-width': 2.5,
        'text-opacity': ['case', ['boolean', ['feature-state', 'available'], true], 1, 0.25],
      },
    });
    updateBoundaryAvailability();
  });
}

function updateBoundaryAvailability() {
  if (!map || !map.getSource('radar-boundaries') || !map.getSource('radar-boundary-labels')) return;
  const slotMs = allTimestamps.length ? new Date(allTimestamps[currentIndex]).getTime() : null;
  for (const range of RANGES) {
    const frame = slotMs !== null ? framesMap[range]?.get(slotMs) : null;
    const available = Boolean(frame && !failedImages.has(frame.url));
    map.setFeatureState({ source: 'radar-boundaries', id: range }, { available });
    map.setFeatureState({ source: 'radar-boundary-labels', id: range }, { available });
    if (map.getSource('radar-boundary-circles'))
      map.setFeatureState({ source: 'radar-boundary-circles', id: range }, { available });
  }
}

const LIGHTNING_BOLT_PATH = 'M13 2 3 14h7l-2 8 11-13h-7l1-7Z';

function strikesInWindow() {
  if (!allTimestamps.length || !lightningStrikes.length) return [];
  const ts = new Date(allTimestamps[currentIndex]).getTime();
  const prev =
    currentIndex > 0 ? new Date(allTimestamps[currentIndex - 1]).getTime() : ts - 5 * 60 * 1000;
  const lo = currentIndex > 0 ? prev : ts - LIGHTNING_MAX_AGE;
  const out = [];
  for (const s of lightningStrikes) {
    if (s.t > ts || s.t <= lo) continue;
    out.push(s);
  }
  return out;
}

function ensureLightningImage() {
  if (map.hasImage('lightning-bolt')) return;
  const canvas = document.createElement('canvas');
  canvas.width = 24 * SHAPE_SCALE;
  canvas.height = 24 * SHAPE_SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SHAPE_SCALE, SHAPE_SCALE);
  const path = new Path2D(LIGHTNING_BOLT_PATH);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke(path);
  ctx.fillStyle = '#fff';
  ctx.fill(path);
  map.addImage('lightning-bolt', ctx.getImageData(0, 0, canvas.width, canvas.height), {
    pixelRatio: SHAPE_SCALE,
  });
}

function addLightningLayer() {
  if (!map || map.getSource('lightning')) return;
  ensureLightningImage();
  map.addSource('lightning', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'lightning-layer',
    type: 'symbol',
    source: 'lightning',
    layout: {
      'icon-image': 'lightning-bolt',
      'icon-anchor': 'center',
      'icon-allow-overlap': true,
      'symbol-z-order': 'source',
      'icon-size': ['interpolate', ['linear'], ['get', 'age'], 0, 1, 300, 0.5],
    },
    paint: {
      'icon-opacity': ['interpolate', ['linear'], ['get', 'age'], 0, 1, 300, 0.5],
    },
  });
  renderLightning();
}

function renderLightning() {
  if (!map || !map.getSource('lightning')) return;
  const strikes = showLightning ? strikesInWindow() : [];
  const ts = allTimestamps.length ? new Date(allTimestamps[currentIndex]).getTime() : Date.now();
  const features = strikes.map((s) => ({
    type: 'Feature',
    properties: { age: Math.max(0, ts - s.t) / 1000 },
    geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
  }));
  map.getSource('lightning').setData({ type: 'FeatureCollection', features });
  map.setLayoutProperty(
    'lightning-layer',
    'visibility',
    showLightning && strikes.length ? 'visible' : 'none',
  );
}

// Particles draw with the 2D API onto an offscreen canvas (trails persist via destination-in
// fades); a custom layer uploads it as a texture so wind lives inside the map's layer stack.
const windCanvas = document.createElement('canvas');
const windCtx = windCanvas.getContext('2d');
const WIND_LAYER_ID = 'wind-layer';
const LAND_OUTLINE_LAYER_ID = 'land-outline';
const LAND_OUTLINE_INLAND_LAYER_ID = 'land-outline-inland';
let windProgram = null;
let windTexture = null;
let windQuadBuffer = null;
let windAPos = 0;
let windUTex = 0;
let windNeedsUpload = false;
// CSS-pixel viewport size, cached for the per-frame loop (canvas is fixed at 100% × 100%).
let windViewW = 0;
let windViewH = 0;
const windMotionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const WIND_KNOTS_TO_MS = 0.514444;
const WIND_SPEEDUP = 500;
const WIND_FADE = 0.93;
const WIND_MAX_PARTICLES = 3200;
const WIND_COLOR_BUCKETS = 14;
const windSample = { u: 0, v: 0, m: 0 };
const windPx = new Float32Array(WIND_MAX_PARTICLES);
const windPy = new Float32Array(WIND_MAX_PARTICLES);
const windSx = new Float32Array(WIND_MAX_PARTICLES);
const windSy = new Float32Array(WIND_MAX_PARTICLES);
const windAge = new Float32Array(WIND_MAX_PARTICLES);
const windLife = new Float32Array(WIND_MAX_PARTICLES);
const windBucketXY = Array.from(
  { length: WIND_COLOR_BUCKETS },
  () => new Float32Array(WIND_MAX_PARTICLES * 4),
);
const windBucketN = new Int32Array(WIND_COLOR_BUCKETS);
let windField = null;
let windSpawn = null;
let windLastT = 0;
let windClearNext = false;
let windParticleCount = 0;
let windDataAt = 0;
let windLoading = null;
let windPaletteTheme = null;
let windPalette = [];

function windBucketStyles() {
  const theme = resolvedTheme();
  if (windPaletteTheme === theme) return windPalette;
  windPaletteTheme = theme;
  // Achromatic ink ramp: monochrome streaks never collide with the radar's rainbow scale.
  const stops =
    theme === 'dark'
      ? ['#8a99a3', '#c2ced5', '#eef4f6', '#eef4f6']
      : ['#5b6e76', '#2f4149', '#0f2129', '#0a161c'];
  windPalette = [];
  for (let b = 0; b < WIND_COLOR_BUCKETS; b++) {
    const t = (b / (WIND_COLOR_BUCKETS - 1)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t));
    const f = t - i;
    const ca = parseInt(stops[i].slice(1), 16);
    const cb = parseInt(stops[i + 1].slice(1), 16);
    const mix = (shift) =>
      Math.round(((ca >> shift) & 255) + (((cb >> shift) & 255) - ((ca >> shift) & 255)) * f);
    windPalette.push(`rgb(${mix(16)}, ${mix(8)}, ${mix(0)})`);
  }
  return windPalette;
}

function buildWindField(stations) {
  // IDW (p=3) over stations on a ~450 m grid; mask is full within ~9 km of a station, zero past ~24 km.
  const PAD = 0.25;
  let minLng = Infinity,
    maxLng = -Infinity,
    minLat = Infinity,
    maxLat = -Infinity;
  for (const s of stations) {
    if (s.lng < minLng) minLng = s.lng;
    if (s.lng > maxLng) maxLng = s.lng;
    if (s.lat < minLat) minLat = s.lat;
    if (s.lat > maxLat) maxLat = s.lat;
  }
  minLng -= PAD;
  maxLng += PAD;
  minLat -= PAD;
  maxLat += PAD;
  const nx = clamp(Math.round((maxLng - minLng) / 0.004), 48, 300);
  const ny = clamp(Math.round((maxLat - minLat) / 0.004), 48, 300);
  const dLng = (maxLng - minLng) / (nx - 1);
  const dLat = (maxLat - minLat) / (ny - 1);
  const u = new Float32Array(nx * ny);
  const v = new Float32Array(nx * ny);
  const m = new Float32Array(nx * ny);
  const R0 = 0.08,
    R1 = 0.22;
  for (let j = 0; j < ny; j++) {
    const lat = minLat + j * dLat;
    for (let i = 0; i < nx; i++) {
      const lng = minLng + i * dLng;
      let wSum = 0,
        uSum = 0,
        vSum = 0,
        dMin = Infinity;
      for (let k = 0; k < stations.length; k++) {
        const s = stations[k];
        const dx = lng - s.lng;
        const dy = lat - s.lat;
        const d2 = dx * dx + dy * dy;
        if (d2 < dMin) dMin = d2;
        const w = 1 / (d2 * Math.sqrt(d2) + 1e-9);
        wSum += w;
        uSum += w * s.u;
        vSum += w * s.v;
      }
      const d = Math.sqrt(dMin);
      let mask = 1;
      if (d > R0) {
        const t = clamp((d - R0) / (R1 - R0), 0, 1);
        mask = 1 - t * t * (3 - 2 * t);
      }
      const idx = j * nx + i;
      u[idx] = (uSum / wSum) * mask;
      v[idx] = (vSum / wSum) * mask;
      m[idx] = mask;
    }
  }
  return { minLng, minLat, maxLng, maxLat, dLng, dLat, nx, ny, u, v, m };
}

function sampleWind(lng, lat) {
  const f = windField;
  if (!f) {
    windSample.u = windSample.v = windSample.m = 0;
    return windSample;
  }
  const gx = clamp((lng - f.minLng) / f.dLng, 0, f.nx - 1.0001);
  const gy = clamp((lat - f.minLat) / f.dLat, 0, f.ny - 1.0001);
  const x0 = gx | 0;
  const y0 = gy | 0;
  const fx = gx - x0;
  const fy = gy - y0;
  const i00 = y0 * f.nx + x0;
  const i10 = i00 + 1;
  const i01 = i00 + f.nx;
  const i11 = i01 + 1;
  const w00 = (1 - fx) * (1 - fy),
    w10 = fx * (1 - fy),
    w01 = (1 - fx) * fy,
    w11 = fx * fy;
  windSample.u = f.u[i00] * w00 + f.u[i10] * w10 + f.u[i01] * w01 + f.u[i11] * w11;
  windSample.v = f.v[i00] * w00 + f.v[i10] * w10 + f.v[i01] * w01 + f.v[i11] * w11;
  windSample.m = f.m[i00] * w00 + f.m[i10] * w10 + f.m[i01] * w01 + f.m[i11] * w11;
  return windSample;
}

function updateWindSpawn() {
  windSpawn = null;
  if (!map || !windField) return;
  const f = windField;
  const b = map.getBounds();
  const minLng = Math.max(b.getWest() - 0.05, f.minLng);
  const maxLng = Math.min(b.getEast() + 0.05, f.maxLng);
  const minLat = Math.max(b.getSouth() - 0.05, f.minLat);
  const maxLat = Math.min(b.getNorth() + 0.05, f.maxLat);
  if (maxLng > minLng && maxLat > minLat) windSpawn = { minLng, minLat, maxLng, maxLat };
  // Count follows the field's on-screen size (capped by viewport) so zooming out thins the cloud.
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const corner of [
    [f.minLng, f.maxLat],
    [f.maxLng, f.maxLat],
    [f.maxLng, f.minLat],
    [f.minLng, f.minLat],
  ]) {
    const p = map.project(corner);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const fieldPx = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
  const viewPx = window.innerWidth * window.innerHeight;
  const area = Math.min(viewPx, fieldPx);
  // Constant per-pixel density; below ~35k px of field on screen the count decays with it, so far zoom-outs fade to a speck instead of balling up.
  windParticleCount = clamp(
    Math.round(Math.max(area / 650, Math.min(350, area / 50))),
    25,
    WIND_MAX_PARTICLES,
  );
}

function respawnAllWind() {
  if (!windField) return;
  for (let i = 0; i < windParticleCount; i++) windRespawn(i);
}

function windRespawn(i) {
  const f = windField;
  if (!f) return;
  // Respawn inside the visible slice of the field so on-screen density stays zoom-independent.
  const box = windSpawn || f;
  let bestLng = box.minLng,
    bestLat = box.minLat,
    bestM = -1;
  for (let tries = 0; tries < 10; tries++) {
    const lng = box.minLng + Math.random() * (box.maxLng - box.minLng);
    const lat = box.minLat + Math.random() * (box.maxLat - box.minLat);
    const m = sampleWind(lng, lat).m;
    if (m > bestM) {
      bestM = m;
      bestLng = lng;
      bestLat = lat;
    }
    if (m > 0.06) break;
  }
  windPx[i] = bestLng;
  windPy[i] = bestLat;
  windAge[i] = -Math.random() * 1500;
  windLife[i] = 5000 + Math.random() * 4000;
  windSx[i] = NaN;
}

function stepWind(now) {
  let dt = now - windLastT;
  windLastT = now;
  dt = clamp(dt, 4, 50);
  const w = windViewW;
  const h = windViewH;
  if (windClearNext) {
    windCtx.clearRect(0, 0, w, h);
    windClearNext = false;
  } else {
    windCtx.globalCompositeOperation = 'destination-in';
    windCtx.fillStyle = `rgba(0, 0, 0, ${WIND_FADE})`;
    windCtx.fillRect(0, 0, w, h);
    windCtx.globalCompositeOperation = 'source-over';
  }
  windBucketN.fill(0);
  const step = (dt / 1000) * WIND_SPEEDUP;
  for (let i = 0; i < windParticleCount; i++) {
    windAge[i] += dt;
    if (windAge[i] > windLife[i]) {
      windRespawn(i);
      continue;
    }
    const lng = windPx[i];
    const lat = windPy[i];
    sampleWind(lng, lat);
    if (windSample.m < 0.03) {
      windRespawn(i);
      continue;
    }
    const u = windSample.u;
    const v = windSample.v;
    const nLng = lng + (u * step) / (111320 * Math.cos((lat * Math.PI) / 180));
    const nLat = lat + (v * step) / 110540;
    windPx[i] = nLng;
    windPy[i] = nLat;
    const p = map.project([nLng, nLat]);
    const x0 = windSx[i];
    if (x0 === x0) {
      let b = Math.round(Math.sqrt(u * u + v * v) / WIND_KNOTS_TO_MS / 1.6);
      if (b >= WIND_COLOR_BUCKETS) b = WIND_COLOR_BUCKETS - 1;
      else if (b < 0) b = 0;
      const n = windBucketN[b];
      const seg = windBucketXY[b];
      const o = n * 4;
      seg[o] = x0;
      seg[o + 1] = windSy[i];
      seg[o + 2] = p.x;
      seg[o + 3] = p.y;
      windBucketN[b] = n + 1;
    }
    if (p.x < -80 || p.y < -80 || p.x > w + 80 || p.y > h + 80) {
      windAge[i] += 400;
      windSx[i] = NaN;
    } else {
      windSx[i] = p.x;
      windSy[i] = p.y;
    }
  }
  const palette = windBucketStyles();
  windCtx.globalAlpha = 0.8;
  windCtx.lineWidth = 2.4;
  windCtx.lineCap = 'round';
  for (let b = 0; b < WIND_COLOR_BUCKETS; b++) {
    const n = windBucketN[b];
    if (!n) continue;
    const seg = windBucketXY[b];
    windCtx.strokeStyle = palette[b];
    windCtx.beginPath();
    for (let k = 0; k < n; k++) {
      const o = k * 4;
      windCtx.moveTo(seg[o], seg[o + 1]);
      windCtx.lineTo(seg[o + 2], seg[o + 3]);
    }
    windCtx.stroke();
  }
  windCtx.globalAlpha = 1;
}

function renderWindStatic() {
  sizeWindCanvas();
  const w = windViewW;
  const h = windViewH;
  windCtx.clearRect(0, 0, w, h);
  if (!windField || !map) return;
  const palette = windBucketStyles();
  windCtx.globalAlpha = 0.5;
  windCtx.lineWidth = 2;
  windCtx.lineCap = 'round';
  // Fixed segment budget so big viewports don't block for hundreds of ms in one task;
  // streamline extent stays constant, only sampling gets coarser.
  const steps = clamp(Math.round(32000 / windParticleCount), 15, 110);
  const step = (0.04 * WIND_SPEEDUP * 110) / steps;
  for (let i = 0; i < windParticleCount; i++) {
    windRespawn(i);
    let lng = windPx[i];
    let lat = windPy[i];
    sampleWind(lng, lat);
    if (windSample.m < 0.03) continue;
    let b = Math.round(
      Math.sqrt(windSample.u * windSample.u + windSample.v * windSample.v) / WIND_KNOTS_TO_MS / 1.6,
    );
    b = clamp(b, 0, WIND_COLOR_BUCKETS - 1);
    windCtx.strokeStyle = palette[b];
    windCtx.beginPath();
    let p = map.project([lng, lat]);
    windCtx.moveTo(p.x, p.y);
    for (let s = 0; s < steps; s++) {
      sampleWind(lng, lat);
      if (windSample.m < 0.03) break;
      lng += (windSample.u * step) / (111320 * Math.cos((lat * Math.PI) / 180));
      lat += (windSample.v * step) / 110540;
      p = map.project([lng, lat]);
      windCtx.lineTo(p.x, p.y);
    }
    windCtx.stroke();
  }
  windCtx.globalAlpha = 1;
  windNeedsUpload = true;
  // The map may be idle (no camera motion), so nudge one repaint to show the static render.
  if (map && map.getLayer(WIND_LAYER_ID)) map.triggerRepaint();
}

function sizeWindCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  windViewW = w;
  windViewH = h;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (windCanvas.width !== bw || windCanvas.height !== bh) {
    windCanvas.width = bw;
    windCanvas.height = bh;
  }
  windCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  windParticleCount = clamp(Math.round((w * h) / 650), 500, WIND_MAX_PARTICLES);
}

const WIND_VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;
const WIND_FRAG = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
void main() {
  vec4 c = texture2D(u_tex, v_uv);
  gl_FragColor = vec4(c.rgb * c.a, c.a);
}
`;

function initWindGL(gl) {
  if (windProgram) return;
  const compile = (type, src) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, WIND_VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, WIND_FRAG));
  gl.linkProgram(program);
  windProgram = program;
  windAPos = gl.getAttribLocation(program, 'a_pos');
  windUTex = gl.getUniformLocation(program, 'u_tex');
  windQuadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, windQuadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  windTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, windTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function compositeWind(gl) {
  const mapCanvas = map.getCanvas();
  if (!mapCanvas.width || !mapCanvas.height) return;
  const prevViewport = gl.getParameter(gl.VIEWPORT);
  const prevDepth = gl.isEnabled(gl.DEPTH_TEST);
  const prevBlend = gl.isEnabled(gl.BLEND);
  gl.viewport(0, 0, mapCanvas.width, mapCanvas.height);
  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  // Canvas2D strokes are straight alpha; premultiply here so blending matches source-over.
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(windProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, windTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, windCanvas);
  gl.uniform1i(windUTex, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, windQuadBuffer);
  gl.enableVertexAttribArray(windAPos);
  gl.vertexAttribPointer(windAPos, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.disableVertexAttribArray(windAPos);
  gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
  if (prevDepth) gl.enable(gl.DEPTH_TEST);
  if (!prevBlend) gl.disable(gl.BLEND);
}

const windCustomLayer = {
  id: WIND_LAYER_ID,
  type: 'custom',
  renderingMode: '2d',
  onAdd(map, gl) {
    initWindGL(gl);
  },
  render(gl) {
    if (!showWind || !windField || !windProgram) return;
    if (windMotionQuery.matches) {
      // Frames repaint from scratch, so keep compositing; only re-upload when redrawn.
      windNeedsUpload = false;
    } else {
      stepWind(performance.now());
      map.triggerRepaint();
    }
    compositeWind(gl);
  },
};

function addWindLayer() {
  if (!map || !styleReady) return;
  // setStyle() preserves custom layers but re-inserts them mid-stack; re-add above the rasters.
  if (map.getLayer(WIND_LAYER_ID)) map.removeLayer(WIND_LAYER_ID);
  map.addLayer(windCustomLayer);
  map.setLayoutProperty(WIND_LAYER_ID, 'visibility', showWind ? 'visible' : 'none');
}

function startWindLoop() {
  if (!showWind || !map || !map.getLayer(WIND_LAYER_ID)) return;
  if (windMotionQuery.matches) {
    renderWindStatic();
    return;
  }
  windLastT = performance.now();
  map.triggerRepaint();
}

function setWindOverlay(on) {
  const hasLayer = !!map?.getLayer(WIND_LAYER_ID);
  if (on) {
    sizeWindCanvas();
    for (let i = 0; i < WIND_MAX_PARTICLES; i++) windSx[i] = NaN;
    if (hasLayer) {
      map.setLayoutProperty(WIND_LAYER_ID, 'visibility', 'visible');
      startWindLoop();
    }
    loadWind();
  } else {
    if (hasLayer) map.setLayoutProperty(WIND_LAYER_ID, 'visibility', 'none');
    windCtx.clearRect(0, 0, windCanvas.width, windCanvas.height);
    windNeedsUpload = false;
  }
}

function windInvalidateScreen() {
  if (!showWind) return;
  updateWindSpawn();
  if (windMotionQuery.matches) {
    windCtx.clearRect(0, 0, windViewW, windViewH);
    return;
  }
  windClearNext = true;
  for (let i = 0; i < windParticleCount; i++) windSx[i] = NaN;
}

async function loadWind() {
  if (!showWind || (windField && Date.now() - windDataAt < 4 * 60 * 1000)) {
    // Fresh cache or hidden tab: the map's animation chain may have stalled, so nudge a frame.
    if (showWind && !windMotionQuery.matches && map?.getLayer(WIND_LAYER_ID)) map.triggerRepaint();
    return;
  }
  if (windLoading) return windLoading;
  const run = (async () => {
    setBusy(true);
    try {
      const speedUrl = apiURL('/wind-speed');
      const dirUrl = apiURL('/wind-direction');
      const [speedJson, dirJson] = await Promise.all([
        fetchJsonCached(speedUrl),
        fetchJsonCached(dirUrl),
      ]);
      assertApiOk(speedJson, speedUrl);
      assertApiOk(dirJson, dirUrl);
      const speedByStation = new Map();
      for (const r of speedJson.data.readings?.[0]?.data || [])
        speedByStation.set(r.stationId, r.value);
      const dirByStation = new Map();
      for (const r of dirJson.data.readings?.[0]?.data || [])
        dirByStation.set(r.stationId, r.value);
      const stations = [];
      for (const s of speedJson.data.stations || []) {
        const knots = speedByStation.get(s.id);
        const dir = dirByStation.get(s.id);
        if (!s.location || knots == null || dir == null) continue;
        const speedMs = knots * WIND_KNOTS_TO_MS;
        // Readings report meteorological "from" direction; particles flow the opposite way.
        const toRad = ((dir + 180) * Math.PI) / 180;
        stations.push({
          lng: s.location.longitude,
          lat: s.location.latitude,
          u: speedMs * Math.sin(toRad),
          v: speedMs * Math.cos(toRad),
        });
      }
      if (stations.length < 3) throw new Error('Insufficient wind stations');
      windField = buildWindField(stations);
      updateWindSpawn();
      windDataAt = Date.now();
      if (windMotionQuery.matches) renderWindStatic();
      else if (map?.getLayer(WIND_LAYER_ID)) map.triggerRepaint();
    } finally {
      setBusy(false);
    }
  })();
  windLoading = run;
  try {
    await run;
  } catch (e) {
    console.error('Wind fetch error:', e);
    if (showWind) showToast('Wind data unavailable');
  } finally {
    windLoading = null;
  }
}

window.addEventListener('resize', () => {
  computeTickMidpoints();
  if (!showWind) return;
  sizeWindCanvas();
  if (windMotionQuery.matches) renderWindStatic();
  else windClearNext = true;
});
windMotionQuery.addEventListener('change', () => {
  if (showWind) startWindLoop();
});

// Warm frames around the current slot so timeline scrubbing doesn't wait on the network.
function prefetchFrames(index) {
  const lo = Math.max(0, index - 3);
  const hi = Math.min(allTimestamps.length - 1, index + 3);
  for (let i = lo; i <= hi; i++) {
    const slotMs = new Date(allTimestamps[i]).getTime();
    for (const range of RANGES) {
      const frame = framesMap[range]?.get(slotMs);
      if (!frame || failedImages.has(frame.url)) continue;
      prepareFrameImage(range, frame).catch(() => {});
    }
  }
}

function showFrame(index) {
  if (!allTimestamps.length) return;
  currentIndex = index;
  const slotMs = new Date(allTimestamps[index]).getTime();

  for (const range of RANGES) {
    applyRadarFrame(range, framesMap[range]?.get(slotMs));
  }
  renderLightning();
  updateBoundaryAvailability();
  prefetchFrames(index);

  updateSliderUI(index);
}

const timeSlider = document.getElementById('time-slider');
function commitIndex(index) {
  showFrame(index);
  const slotMs = allTimestamps[index] ? new Date(allTimestamps[index]).getTime() : null;
  pinnedSlot = index === allTimestamps.length - 1 ? null : slotMs;
}
// Pointermove fires faster than the frame rate; commit at most one scrub step per frame.
let pendingCommitIndex = -1;
let commitRafId = 0;
function scheduleCommit(index) {
  pendingCommitIndex = index;
  if (commitRafId) return;
  commitRafId = requestAnimationFrame(() => {
    commitRafId = 0;
    const i = pendingCommitIndex;
    pendingCommitIndex = -1;
    if (i >= 0 && i !== currentIndex) commitIndex(i);
  });
}
function commitIndexNow(index) {
  pendingCommitIndex = -1;
  if (commitRafId) {
    cancelAnimationFrame(commitRafId);
    commitRafId = 0;
  }
  commitIndex(index);
}
function tickIndexFromX(clientX) {
  if (tickMidpoints.length !== document.getElementById('slider-ticks').children.length - 1) {
    computeTickMidpoints();
  }
  for (let i = 0; i < tickMidpoints.length; i++) {
    if (clientX < tickMidpoints[i]) return i;
  }
  return tickMidpoints.length;
}
const sliderTicks = document.getElementById('slider-ticks');
sliderTicks.addEventListener('pointermove', (e) => {
  if (allTimestamps.length < 2) return;
  scheduleCommit(tickIndexFromX(e.clientX));
});
sliderTicks.addEventListener('pointerdown', (e) => {
  if (allTimestamps.length < 2) return;
  commitIndexNow(tickIndexFromX(e.clientX));
});
timeSlider.addEventListener('input', (e) => scheduleCommit(parseInt(e.target.value)));
timeSlider.addEventListener('change', (e) => commitIndexNow(parseInt(e.target.value)));
timeSlider.addEventListener('pointerup', () => commitIndexNow(parseInt(timeSlider.value)));
timeSlider.addEventListener('keyup', () => commitIndexNow(parseInt(timeSlider.value)));
timeSlider.addEventListener('pointermove', (e) => {
  if (allTimestamps.length < 2) return;
  const rect = timeSlider.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const index = Math.round(ratio * (allTimestamps.length - 1));
  scheduleCommit(index);
});

function restartCountdown() {
  // Busy mode owns the donut; countdown resumes when setBusy clears.
  if (busyCount > 0) return;
  const el = document.getElementById('refresh-donut');
  const duration = Math.max(1, Math.round((nextFetchAt - Date.now()) / 1000));
  el.querySelector('.donut-progress').style.animationDuration = `${duration}s`;
  el.classList.remove('anim');
  void el.offsetWidth;
  el.classList.add('anim');
}

function tickCountdown() {
  const el = document.getElementById('refresh-donut');
  if (el.classList.contains('loading')) return;
  const remaining = Math.max(0, Math.ceil((nextFetchAt - Date.now()) / 1000));
  const label = `Next update in ${remaining}s`;
  el.querySelector('.donut-value').textContent = remaining;
  el.setAttribute('title', label);
  el.setAttribute('aria-label', label);
}

pruneApiCache();
initMap();
fetchAtSlot();
restartCountdown();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (showWind) loadWind();
  if (pollRanges.length) pollOnce();
  else if (Date.now() - lastFetchStart > SLOT_MS) fetchAtSlot();
});
setInterval(tickCountdown, 1000);
