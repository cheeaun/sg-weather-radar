import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
// MRT/LRT lines + stations from cheeaun/sgraildata, compiled to rail.json by
// scripts/build-rail-data.mjs (delta-encoded int coords at 1e-5 deg). Imported
// so Vite bundles it under a content hash like the rest of the assets.
import railRaw from './rail.json';
import SINGAPORE_AREAS from './areas-idx.json';
// Pre-computed pixel→planning-area index for the 70 km radar, built by
// scripts/build-rain-data.mjs from the planning-area source. Flat array of
// delta-encoded [pixelDelta, areaIdx] pairs; each areaIdx indexes SINGAPORE_AREAS.
import SG_RAIN_PIXELS from './rain-pixels.json';

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
const WINDOW_MS = PAST_HOURS * 60 * 60 * 1000 + FETCH_PAD_MS;
const TICK_RANGES = [480, 240, 70];
const LIGHTNING_MAX_AGE = 10 * 60 * 1000;

const THEME_STORAGE_KEY = 'sgwr-theme';
const OPACITY_STORAGE_KEY = 'sgwr-radar-opacity';
const CLIP_STORAGE_KEY = 'sgwr-radar-clip';
const LIGHTNING_STORAGE_KEY = 'sgwr-lightning';
const WIND_STORAGE_KEY = 'sgwr-wind';
const NOWCAST_STORAGE_KEY = 'sgwr-nowcast';
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
let playbackTimer = null;
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
let showNowcast = localStorage.getItem(NOWCAST_STORAGE_KEY) === 'on';
let lightningStrikes = [];
let lightningLoading = null;
const failedImages = new Set();
const nowcastCanvases = new Map();
let nowcastGeneration = 0;
let nowcastControlButton = null;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function slotOf(iso) {
  return Math.floor(new Date(iso).getTime() / SLOT_MS) * SLOT_MS;
}

function rangeShapeSVG(range, future = false) {
  const shape = future && range === 70 ? 'range-shape-70-future' : `range-shape-${range}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><use href="#${shape}"/></svg>`;
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

class NowcastToggleControl {
  onAdd(map) {
    this._map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toggle-btn';
    button.innerHTML =
      '<svg class="toggle-icon nowcast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 18.5 9 13l3.5 3.5L20 9"/><path d="M15.5 9H20v4.5"/></svg>';
    button.addEventListener('click', () => {
      showNowcast = !showNowcast;
      localStorage.setItem(NOWCAST_STORAGE_KEY, showNowcast ? 'on' : 'off');
      this._updateButton();
      if (showNowcast) {
        Promise.allSettled([
          loadWind({ forNowcast: true }),
          refreshLightning({ forNowcast: true }),
        ]).finally(() => {
          if (showNowcast) recomputeNowcast();
        });
      } else {
        recomputeNowcast();
      }
      showToast(showNowcast ? 'Showing 15-minute nowcast' : 'Hiding 15-minute nowcast');
    });
    this._button = button;
    nowcastControlButton = button;
    container.appendChild(button);
    this._container = container;
    this._updateButton();
    return container;
  }
  _updateButton() {
    const fit = modelFitPercent();
    const fitText = fit == null ? 'model fit pending' : `model fit ${fit}% (rolling 1 h)`;
    const label = 'Show 15-minute nowcast (70 km)';
    this._button.title = `${fitText} · short-range rain estimate`;
    this._button.setAttribute('aria-label', label);
    this._button.setAttribute('aria-pressed', String(showNowcast));
    this._button.classList.toggle('toggle-active', showNowcast);
  }
  onRemove() {
    if (this._container) this._container.remove();
    this._container = undefined;
    this._map = undefined;
    nowcastControlButton = null;
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
  map.addControl(new NowcastToggleControl(), 'bottom-right');
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
  loadRailData();
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
    addRailLayers();
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

// Returns { data, fresh }; fresh means the data came from upstream, so callers must
// never cache it into a fresh-looking entry when it was actually a stale-cache fallback.
async function fetchWithRetry(url, cached) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (res.ok) return { data: await res.json(), fresh: true };
      if (res.status === 409 && cached) return { data: cached.data, fresh: false };
    } catch (e) {
      if (cached) return { data: cached.data, fresh: false };
      if (attempt > FETCH_RETRIES) throw new Error(`${e.message || 'fetch failed'} [${url}]`);
      await delay(FETCH_RETRY_DELAY);
      continue;
    }
    if (cached) return { data: cached.data, fresh: false };
    if (attempt <= FETCH_RETRIES) {
      await delay(FETCH_RETRY_DELAY);
      continue;
    }
    throw new Error(await httpErrorMessage(res, url));
  }
}

function isCacheable(json) {
  // Only envelopes the app itself accepts via assertApiOk may enter the cache.
  return !!json && json.code === 0;
}

// Single fetch reader for all API consumers. maxAgeMs is an age budget: within it, cached
// data short-circuits without touching the network; beyond it the network answers, falling
// back to stale cache only on failure (which must never be re-stamped as fresh).
async function apiFetch(url, { maxAgeMs = 0 } = {}) {
  if (inflightFetches.has(url)) return inflightFetches.get(url);
  const promise = (async () => {
    const cached = readApiCache(url);
    if (cached && Date.now() - cached.cachedAt < maxAgeMs) return cached.data;

    const { data, fresh } = await fetchWithRetry(url, cached);
    if (fresh && isCacheable(data)) writeApiCache(url, data);
    return data;
  })();
  inflightFetches.set(url, promise);
  try {
    return await promise;
  } finally {
    inflightFetches.delete(url);
  }
}

async function fetchDayForRange(range, dateStr, paginationToken, fetchFn) {
  const url = apiURL(`/weather-radar-images/${range}km`, { date: dateStr, paginationToken });
  // fetchFn is injected rather than defaulted: the cache-only first paint pass in
  // doFetchRadar substitutes a synchronous reader for the network path.
  const json = await fetchFn(url);
  assertApiOk(json, url);
  return json;
}

async function fetchLightningDay(dateStr, paginationToken, fetchFn) {
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

async function refreshLightning({ forNowcast = false } = {}) {
  if (!showLightning && !forNowcast) return null;
  if (lightningLoading) return lightningLoading;
  lightningLoading = loadLightningData((url) => apiFetch(url, { maxAgeMs: API_CACHE_TTL }))
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
  const cutoff = new Date(now.getTime() - WINDOW_MS);
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

        const usable = allRecords.filter((r) => r.image && r.image.url);
        let frames = [];
        if (usable.length) {
          // A lagging feed must still show its newest frames: anchor the window on
          // the latest published frame instead of dropping everything as "expired".
          let cutoffMs = cutoff.getTime();
          const newest = Math.max(...usable.map((r) => new Date(r.timestamp).getTime()));
          if (newest - WINDOW_MS < cutoffMs) cutoffMs = newest - WINDOW_MS;
          frames = usable
            .filter((r) => new Date(r.timestamp).getTime() >= cutoffMs)
            .map((r) => ({ url: r.image.url, timestamp: r.timestamp }))
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        }

        return { range, bb, frames };
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
  const prevBoxes = boundaryBoxes;
  const prevFrames = framesByRange;
  boundaryBoxes = {};
  framesByRange = {};
  framesMap = {};
  failedImages.clear();
  for (const range of RANGES) {
    let result = rangeResults[range];
    // A full refresh that comes back empty for one range (pruned/missed cache read,
    // transient upstream gap) must not erase the frames already on screen.
    if ((!result || !result.frames.length) && prevFrames[range]?.length) {
      result = { bb: prevBoxes[range], frames: prevFrames[range] };
    }
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

  addBoundaryLayers();
  if (showNowcast) recomputeNowcast();
  else {
    const newSlots = rebuildTimeline();
    updateSlider(newSlots);
    showFrame(currentIndex);
  }

  const sig = radarSignature();
  if (lastRadarSignature !== null && sig !== lastRadarSignature) flashNewData();
  lastRadarSignature = sig;
}

function mergeRangeResults(rangeResults) {
  for (const range of RANGES) {
    const result = rangeResults[range];
    if (!result) continue;
    // Same rule as applyRadarData: an empty poll result keeps the existing frames.
    if (!result.frames.length && framesByRange[range]?.length) continue;
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
  if (showNowcast) recomputeNowcast();
  else {
    const newSlots = rebuildTimeline();
    updateSlider(newSlots);
    showFrame(currentIndex);
  }
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
  // Best-effort pass from the session cache so the map paints before the network answers.
  // Cache miss reads as empty records, so the pass itself never errors out on a cold start.
  const cacheMiss = { code: 0, data: { records: [] } };
  const cacheReader = (url) => readApiCache(url)?.data ?? cacheMiss;

  try {
    const [rangeResults, strikes] = await Promise.all([
      loadRadarData(cacheReader),
      showLightning || showNowcast ? loadLightningData(cacheReader).catch(() => null) : null,
    ]);
    if (RANGES.some((range) => rangeResults[range]?.frames.length)) {
      applyRadarData(rangeResults, strikes);
      rendered = true;
    }
  } catch (e) {}

  // Network pass is strictly fresher than the cache pass, so its result is always applied;
  // last-known-frame guards in applyRadarData absorb any transient upstream gaps.
  try {
    const [rangeResults, strikes] = await Promise.all([
      loadRadarData(apiFetch),
      showLightning || showNowcast
        ? loadLightningData(apiFetch).catch((e) => {
            console.error('Lightning fetch error:', e);
          })
        : null,
    ]);
    applyRadarData(rangeResults, strikes);
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
  if (showWind || showNowcast) loadWind({ forNowcast: showNowcast });
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
    const rangeResults = await loadRadarData(apiFetch, ranges);
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

function positionEndpointLabels() {
  const ticks = document.getElementById('slider-ticks').children;
  const footer = document.querySelector('.scan-foot');
  if (!ticks.length || !footer) return;
  const footerRect = footer.getBoundingClientRect();
  const positions = [];
  for (let i = 0; i < ticks.length; i++) {
    const rect = ticks[i].getBoundingClientRect();
    positions.push(rect.left + rect.width / 2 - footerRect.left);
  }
  const liveSlot = newestLiveSlot(70);
  const liveIndex = allTimestamps.findIndex(
    (timestamp) => new Date(timestamp).getTime() === liveSlot,
  );
  const forecastSlot =
    showNowcast && nowcastCanvases.size ? Math.max(...nowcastCanvases.keys()) : null;
  const setPosition = (id, index, edge) => {
    const element = document.getElementById(id);
    if (!element || index < 0 || index >= positions.length) return;
    element.style.left = `${positions[index]}px`;
    element.dataset.edge = edge;
  };
  setPosition('time-oldest', 0, 'start');
  setPosition(
    'time-live',
    liveIndex >= 0 ? liveIndex : positions.length - 1,
    forecastSlot ? 'middle' : 'end',
  );
  setPosition('time-forecast', positions.length - 1, 'end');
}

function renderTicks(newSlots) {
  const container = document.getElementById('slider-ticks');
  container.replaceChildren();
  const n = allTimestamps.length;
  const liveSlot70 = newestLiveSlot(70);
  for (let i = 0; i < n; i++) {
    const col = document.createElement('div');
    col.className = 'tick-col';
    const slotMs = new Date(allTimestamps[i]).getTime();
    for (const range of TICK_RANGES) {
      const shape = document.createElement('span');
      shape.className = 'tick-shape';
      const future = range === 70 && slotMs > liveSlot70;
      shape.innerHTML = rangeShapeSVG(range, future);
      const frame = framesMap[range]?.get(slotMs);
      if (frame && !failedImages.has(frame.url)) {
        shape.classList.add('on');
        if (future) {
          shape.classList.add('nowcast');
          if (nowcastCanvases.get(slotMs) && hasForecastRain(nowcastCanvases.get(slotMs)))
            shape.classList.add('rain');
        }
      }
      col.appendChild(shape);
    }
    if (newSlots && newSlots.has(slotMs)) col.classList.add('new');
    container.appendChild(col);
  }
  computeTickMidpoints();
  positionEndpointLabels();
}

function updateSlider(newSlots) {
  const slider = document.getElementById('time-slider');
  slider.max = Math.max(0, allTimestamps.length - 1);
  const liveSlot = newestLiveSlot(70);
  const forecastSlot =
    showNowcast && Number.isFinite(liveSlot) && nowcastCanvases.size
      ? Math.max(...nowcastCanvases.keys())
      : null;
  const hasForecast = Boolean(forecastSlot);
  const oldestTime = allTimestamps.length ? formatTime(allTimestamps[0]) : '--:--';
  const liveTime = Number.isFinite(liveSlot)
    ? formatTime(new Date(liveSlot).toISOString())
    : oldestTime;
  document.getElementById('time-oldest').textContent = oldestTime;
  document.getElementById('time-live').textContent = liveTime;
  document.getElementById('time-forecast').textContent = forecastSlot
    ? formatTime(new Date(forecastSlot).toISOString())
    : '';
  document.querySelector('.scan-foot').classList.toggle('has-forecast', hasForecast);
  renderTicks(newSlots);
  updateSliderUI(currentIndex);
}

function updateSliderUI(index) {
  const slider = document.getElementById('time-slider');
  const max = Number(slider.max) || 0;
  slider.value = clamp(Number(index) || 0, 0, max);
  const ts = allTimestamps[index];

  const tickCols = document.getElementById('slider-ticks').children;
  for (let i = 0; i < tickCols.length; i++) tickCols[i].classList.toggle('active', i === index);

  document.getElementById('scan-time').textContent = ts ? formatTime(ts) : '--:--';
  document.getElementById('scan-date').textContent = ts ? formatDate(ts) : '--';
  updateSliderCutoff();
}

function updateSliderCutoff() {
  const slider = document.getElementById('time-slider');
  const minTime = allTimestamps.length ? new Date(allTimestamps[0]).getTime() : 0;
  const maxTime = allTimestamps.length
    ? new Date(allTimestamps[allTimestamps.length - 1]).getTime()
    : 0;
  const hasForecast = showNowcast && nowcastCanvases.size && maxTime > minTime;
  const liveEnd = hasForecast
    ? clamp(((Date.now() - minTime) / (maxTime - minTime)) * 100, 0, 100)
    : 100;
  slider.style.setProperty('--slider-live-end', `${liveEnd}%`);
  const index = Number(slider.value) || 0;
  const ts = allTimestamps[index];
  const forecast = Boolean(ts && new Date(ts).getTime() > Date.now());
  slider.classList.toggle('forecast-active', forecast);
  document.getElementById('scan-time').classList.toggle('forecast', forecast);
}

const RADAR_BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const CLIP_SOURCE = { 480: 240, 240: 70 };
const frameImageCache = new Map();
// One canvas per range per slot across the whole visible window (+pad), so replay/scrub
// never evicts a frame it will immediately revisit.
const FRAME_CACHE_MAX = RANGES.length * Math.ceil((PAST_HOURS * 60 * 60 * 1000) / SLOT_MS + 2);
const radarShownKey = new Map();
const radarPendingKey = new Map();

function bbCoordinatesOf(bb) {
  return [
    [bb.upperLeft.longitude, bb.upperLeft.latitude],
    [bb.lowerRight.longitude, bb.upperLeft.latitude],
    [bb.lowerRight.longitude, bb.lowerRight.latitude],
    [bb.upperLeft.longitude, bb.lowerRight.latitude],
  ];
}

function boxRing(bb) {
  return [
    [bb.upperLeft.longitude, bb.upperLeft.latitude],
    [bb.lowerRight.longitude, bb.upperLeft.latitude],
    [bb.lowerRight.longitude, bb.lowerRight.latitude],
    [bb.upperLeft.longitude, bb.lowerRight.latitude],
    [bb.upperLeft.longitude, bb.upperLeft.latitude],
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

let railData = null;

function decodeRail(raw) {
  const s = raw.scale;
  const lineFeatures = raw.lines.map(([name, color, segs]) => ({
    type: 'Feature',
    properties: { name, color },
    geometry: {
      type: 'MultiLineString',
      coordinates: segs.map((seg) => {
        const ring = [];
        let x = 0;
        let y = 0;
        for (let i = 0; i < seg.length; i += 2) {
          x += seg[i];
          y += seg[i + 1];
          ring.push([x / s, y / s]);
        }
        return ring;
      }),
    },
  }));
  // Stations are one delta chain: accumulate from the first absolute pair.
  let sx = 0;
  let sy = 0;
  const stationFeatures = raw.stations.map(([name, x, y, p]) => {
    sx += x;
    sy += y;
    return {
      type: 'Feature',
      properties: { name, p },
      geometry: { type: 'Point', coordinates: [sx / s, sy / s] },
    };
  });
  // Interchanges (higher p) draw on top of single-line stops.
  stationFeatures.sort((a, b) => a.properties.p - b.properties.p);
  return {
    lines: { type: 'FeatureCollection', features: lineFeatures },
    stations: { type: 'FeatureCollection', features: stationFeatures },
  };
}

async function loadRailData() {
  if (railData) return;
  try {
    railData = decodeRail(railRaw);
    addRailLayers();
  } catch (e) {}
}

function addRailLayers() {
  if (!map || !styleReady || !railData || map.getSource('rail-lines')) return;
  map.addSource('rail-lines', { type: 'geojson', data: railData.lines });
  map.addSource('rail-stations', { type: 'geojson', data: railData.stations });
  map.addLayer({
    id: 'rail-line-outline',
    type: 'line',
    source: 'rail-lines',
    minzoom: 10,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': boundaryTextHalo(),
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4],
      'line-opacity': 0.8,
    },
  });
  map.addLayer({
    id: 'rail-line',
    type: 'line',
    source: 'rail-lines',
    minzoom: 10,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2.5],
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    id: 'rail-station-circle',
    type: 'circle',
    source: 'rail-stations',
    minzoom: 12,
    layout: { 'circle-sort-key': ['get', 'p'] },
    paint: {
      'circle-pitch-alignment': 'map',
      'circle-radius': ['case', ['>=', ['get', 'p'], 3], 4.5, ['==', ['get', 'p'], 2], 4, 3],
      'circle-color': boundaryTextColor(),
      'circle-stroke-color': boundaryTextHalo(),
      'circle-stroke-width': 1,
    },
  });
  // Interchange names appear first; plain stations only once zoomed further in.
  map.addLayer({
    id: 'rail-station-label-interchange',
    type: 'symbol',
    source: 'rail-stations',
    minzoom: 13,
    filter: ['>=', ['get', 'p'], 2],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Bold'],
      'text-size': 10,
      'text-anchor': 'top',
      'text-offset': [0, 1],
      'symbol-sort-key': ['get', 'p'],
    },
    paint: {
      'text-color': boundaryTextColor(),
      'text-halo-color': boundaryTextHalo(),
      'text-halo-width': 2,
    },
  });
  map.addLayer({
    id: 'rail-station-label',
    type: 'symbol',
    source: 'rail-stations',
    minzoom: 14,
    filter: ['<', ['get', 'p'], 2],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 10,
      'text-anchor': 'top',
      'text-offset': [0, 1],
    },
    paint: {
      'text-color': boundaryTextColor(),
      'text-halo-color': boundaryTextHalo(),
      'text-halo-width': 2,
    },
  });
  // Rail is usually fetched after style.load, so place labels need re-raising above it.
  raisePlaceLabels();
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

// MapLibre projects the image source from its geographic corner coordinates.
function buildRadarCanvas(range, frame, clip) {
  if (frame.nowcast) {
    const entry = nowcastCanvases.get(new Date(frame.timestamp).getTime());
    if (!entry) return Promise.reject(new Error('Nowcast frame unavailable'));
    // Median member (post spatial-coherence) — max-blend is a 5-member mosaic
    // and reads as digital noise at map zoom. Votes/summaries still use maxBlend.
    return Promise.resolve(entry.display);
  }
  return fetchRadarImage(frame.url).then((blob) =>
    createImageBitmap(blob).then((bitmap) => {
      try {
        const bb = boundaryBoxes[range] || RADAR_BOUNDS[range];
        const W = bitmap.width;
        const H = bitmap.height;
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bitmap, 0, 0);
        const innerRange = CLIP_SOURCE[range];
        if (clip && innerRange) {
          const inner = boundaryBoxes[innerRange] || RADAR_BOUNDS[innerRange];
          const lonSpan = bb.lowerRight.longitude - bb.upperLeft.longitude;
          const west = inner.upperLeft.longitude;
          const east = inner.lowerRight.longitude;
          const latSpan = bb.upperLeft.latitude - bb.lowerRight.latitude;
          const north = inner.upperLeft.latitude;
          const south = inner.lowerRight.latitude;
          let x0 = W,
            x1 = -1;
          for (let x = 0; x < W; x++) {
            const left = bb.upperLeft.longitude + (x / W) * lonSpan;
            const right = bb.upperLeft.longitude + ((x + 1) / W) * lonSpan;
            if (left >= west && right <= east) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
            }
          }
          let y0 = H,
            y1 = -1;
          for (let y = 0; y < H; y++) {
            const lat = bb.upperLeft.latitude - ((y + 0.5) / H) * latSpan;
            if (lat <= north && lat >= south) {
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

// S3 re-signs the image URL on every API fetch even for a timestamp already rendered, so
// identity must be range+timestamp, not the (ever-changing) signed URL, or already-shown
// frames get treated as new/not-yet-available on every refresh.
function frameImageKey(range, frame, clip) {
  return `${range}:${frame.timestamp}${frame.nowcast ? `:${frame.url}` : ''}${clip ? '#clip' : ''}`;
}

function prepareFrameImage(range, frame) {
  // Nowcast canvases live in nowcastCanvases; caching them here keyed by
  // nowcast:slot:seed re-serves a stale bitmap after recompute when the seed
  // (median deltas) is unchanged.
  if (frame.nowcast) return buildRadarCanvas(range, frame, clipBoundaries);
  const key = frameImageKey(range, frame, clipBoundaries);
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
  const layerId = `radar-${range}`;
  const hide = () => {
    radarShownKey.delete(range);
    radarPendingKey.delete(range);
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none');
    updateBoundaryAvailability();
  };
  const key = frame && frameImageKey(range, frame, clipBoundaries);
  // Only the exact signed URL is failed; a re-signed URL for the same timestamp is retried,
  // else stale cached API data (expired S3 URLs) poisons a whole range until the next refresh.
  if (!frame || failedImages.has(frame.url)) {
    hide();
    return;
  }
  map.setLayoutProperty(layerId, 'visibility', 'visible');
  source.setCoordinates(bbCoordinatesOf(boundaryBoxes[range] || RADAR_BOUNDS[range]));
  if (radarShownKey.get(range) === key) {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'visible');
    return;
  }
  radarPendingKey.set(range, key);
  setBusy(true);
  prepareFrameImage(range, frame)
    .then((canvas) => {
      const src = styleReady && map.getSource(`radar-${range}`);
      if (!src || radarPendingKey.get(range) !== key) return;
      src.updateImage({ image: canvas });
      radarShownKey.set(range, key);
      updateBoundaryAvailability();
    })
    .catch(() => {
      if (!failedImages.has(frame.url)) {
        failedImages.add(frame.url);
        renderTicks();
      }
      if (radarPendingKey.get(range) === key) hide();
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
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
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

// Diagonal hatched fill for radar areas that are not (yet) rendered. Tiled at 45°,
// white in light mode / black in dark mode, matching the requested placeholder look.
const STRIPE_PATTERN_SIZE = 8;
const STRIPE_WIDTH = 0.5;
const STRIPE_COLORS = { light: '#ffffff', dark: '#000000' };

function buildStripeImageData(color) {
  const N = STRIPE_PATTERN_SIZE;
  // Supersample so sub-pixel stripe widths antialias (a plain fillRect below 1px just
  // snaps back to hard 1px lines); downscale keeps the 45° pattern seamless.
  const S = 4;
  const tmp = document.createElement('canvas');
  tmp.width = N * S;
  tmp.height = N * S;
  const tctx = tmp.getContext('2d');
  tctx.fillStyle = color;
  for (let y = 0; y < N * S; y++) {
    for (let x = 0; x < N * S; x++) {
      // (x+y) mod period tiles seamlessly in both axes at 45°.
      if ((x + y) % (N * S) < STRIPE_WIDTH * S) tctx.fillRect(x, y, 1, 1);
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmp, 0, 0, N * S, N * S, 0, 0, N, N);
  return ctx.getImageData(0, 0, N, N);
}

const stripeImagePromises = new Map();

function ensureStripeImages() {
  for (const variant of Object.keys(STRIPE_COLORS)) {
    const name = `radar-stripe-${variant}`;
    if (map.hasImage(name)) continue;
    const p = Promise.resolve().then(() => {
      const imageData = buildStripeImageData(STRIPE_COLORS[variant]);
      if (imageData && !map.hasImage(name)) {
        try {
          map.addImage(name, imageData);
        } catch (e) {}
      }
    });
    stripeImagePromises.set(name, p);
  }
  return Promise.all([...stripeImagePromises.values()]);
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
  ensureRangeShapes()
    .then(() => ensureStripeImages())
    .then(() => {
      if (!map || map.getSource('radar-boundaries')) return;
      map.addSource('radar-boundaries', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features },
      });
      map.addSource('radar-stripe', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: stripeFeatures(computeAvailability()) },
      });
      map.addLayer(
        {
          id: 'radar-boundary-stripe',
          type: 'fill',
          source: 'radar-stripe',
          paint: {
            'fill-pattern': `radar-stripe-${resolvedTheme()}`,
            'fill-opacity': 1,
          },
        },
        map.getLayer('wind-layer') ? 'wind-layer' : undefined,
      );
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

function computeAvailability() {
  const slotMs = allTimestamps.length ? new Date(allTimestamps[currentIndex]).getTime() : null;
  const available = {};
  for (const range of RANGES) {
    const frame = slotMs !== null ? framesMap[range]?.get(slotMs) : null;
    const key = frame && frameImageKey(range, frame, clipBoundaries);
    // Available only once the frame's image is actually rendered (not merely fetched),
    // so the striped placeholder stays visible through the loading window.
    available[range] = Boolean(
      frame && !failedImages.has(frame.url) && radarShownKey.get(range) === key,
    );
  }
  return available;
}

// Stripe polygons get a punch-hole for each loaded inner range, mirroring the raster clip:
// a range's placeholder must never paint hatch over a smaller range whose frame is rendered,
// so the loaded rain stays visible (e.g. 70km shown while 240/480 are still loading).
function stripeFeatures(available) {
  const features = [];
  for (const range of RANGES) {
    if (available[range]) continue;
    const bb = boundaryBoxes[range] || RADAR_BOUNDS[range];
    const availInners = RANGES.filter((r) => r < range && available[r]);
    // Nested holes are invalid in GeoJSON; since the ranges nest, only the outermost
    // available inner box(es) are needed — smaller ones are already inside them.
    const holes = availInners
      .filter((r) => !availInners.some((bigger) => bigger > r))
      .map((r) => boxRing(boundaryBoxes[r] || RADAR_BOUNDS[r]));
    features.push({
      type: 'Feature',
      id: range,
      properties: { range },
      geometry: { type: 'Polygon', coordinates: [boxRing(bb), ...holes] },
    });
  }
  return features;
}

function updateBoundaryAvailability() {
  if (!map || !map.getSource('radar-boundaries') || !map.getSource('radar-boundary-labels')) return;
  const available = computeAvailability();
  for (const range of RANGES) {
    map.setFeatureState({ source: 'radar-boundaries', id: range }, { available: available[range] });
    map.setFeatureState(
      { source: 'radar-boundary-labels', id: range },
      { available: available[range] },
    );
    if (map.getSource('radar-boundary-circles'))
      map.setFeatureState(
        { source: 'radar-boundary-circles', id: range },
        { available: available[range] },
      );
  }
  const stripeSource = map.getSource('radar-stripe');
  if (stripeSource)
    stripeSource.setData({ type: 'FeatureCollection', features: stripeFeatures(available) });
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
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
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

async function loadWind({ forNowcast = false } = {}) {
  if ((!showWind && !forNowcast) || (windField && Date.now() - windDataAt < 4 * 60 * 1000)) {
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
      const agedFetch = (url) => apiFetch(url, { maxAgeMs: API_CACHE_TTL });
      const [speedJson, dirJson] = await Promise.all([agedFetch(speedUrl), agedFetch(dirUrl)]);
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
  positionEndpointLabels();
  updateSliderCutoff();
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
  updateRainSummary();
}

// One-line "where is it raining" summary sampled from the 70km radar canvas.
// Areas are URA Master Plan 2025 planning areas, so many hits collapse to
// region terms.
const REGION_LABELS = {
  north: 'north',
  'north-east': 'north-east',
  east: 'east',
  west: 'west',
  central: 'central',
};
const MIN_COMPONENT_PIXELS = 4;
const LEVEL_WORDS = { 1: 'Light', 2: 'Moderate', 3: 'Heavy' };
const NOWCAST_SIZE = 480;
const NOWCAST_FRAMES = 5;
const NOWCAST_DECAY = 0.92;
const NOWCAST_GROWTH_MAX = 0.3;
const NOWCAST_MATCH_DISTANCE = 40;
const NOWCAST_MATCH_OVERLAP = 0.3;
const NOWCAST_SHEET_PIXELS = 4000;
const NOWCAST_SHEET_SIGMA = 8;
const NOWCAST_FIT_MAX_AGE = 60 * 60 * 1000;
const NOWCAST_FIT_MAX_SAMPLES = 120;
const NOWCAST_FIT_POOL = 10;
const NOWCAST_FIT_MIN_PIXELS = 50;
const nowcastFitSamples = [];

// The scale bar in the masthead is the palette the radar images are quantized to;
// map a pixel back to its position on that ramp to classify intensity.
let radarScaleStopsCache = null;
function radarScaleStops() {
  if (radarScaleStopsCache) return radarScaleStopsCache;
  const bg = getComputedStyle(document.querySelector('.scale-gradient')).backgroundImage;
  const stops = [];
  const re = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)[^)]*\)\s+([\d.]+)%/g;
  let m;
  while ((m = re.exec(bg))) {
    stops.push([parseFloat(m[4]) / 100, [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]]);
  }
  radarScaleStopsCache = stops;
  return stops;
}

const rainLevelCache = new Map();
function rainLevelForColor(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  if (rainLevelCache.has(key)) return rainLevelCache.get(key);
  let level = 0;
  // Rain palette colors are fully saturated; background/land pixels are near-grey.
  const sat = Math.max(r, g, b) - Math.min(r, g, b);
  if (sat >= 40) {
    let best = Infinity;
    let t = 0;
    for (const [stop, [sr, sg, sb]] of radarScaleStops()) {
      const dr = r - sr;
      const dg = g - sg;
      const db = b - sb;
      const d = dr * dr + dg * dg + db * db;
      if (d < best) {
        best = d;
        t = stop;
      }
    }
    // Cyan/green = light, yellow = moderate, orange/red/magenta = heavy.
    if (t >= 0.667) level = 3;
    else if (t >= 0.485) level = 2;
    else level = 1;
  }
  rainLevelCache.set(key, level);
  return level;
}

// Attribute every rainy pixel to its planning area via a pre-computed pixel map.
// SG_RAIN_PIXELS (rain-pixels.json) is a flat array of delta-encoded
// [pixelDelta, areaIdx] pairs for the 70 km radar canvas. Decode it once into
// packed pixel and area IDs; each frame then does direct lookups with no
// per-pixel lat/lng conversion, boundary check, or distance calculation.
const SG_RAIN_PIXEL_DATA = (() => {
  const src = SG_RAIN_PIXELS;
  const pixels = new Uint32Array(src.length / 2);
  let key = 0;
  for (let i = 0; i < src.length; i += 2) {
    key += src[i];
    pixels[i / 2] = src[i + 1] * 262144 + key;
  }
  return pixels;
})();
const RAIN_PIXEL_KEY_MASK = (1 << 18) - 1;
const SG_RAIN_PIXEL_AREAS = (() => {
  const areas = new Uint8Array(480 * 480);
  for (const packed of SG_RAIN_PIXEL_DATA) {
    areas[packed & RAIN_PIXEL_KEY_MASK] = (packed >>> 18) + 1;
  }
  return areas;
})();
const RAIN_PIXEL_COUNT = SG_RAIN_PIXEL_DATA.length;
const rainState = new Uint8Array(480 * 480);
const rainMembers = new Uint32Array(480 * 480);
function analyzeRainCells(canvas, fullFrame = false) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const data = ctx.getImageData(0, 0, W, H).data;
  const cells = [];
  // State 1-3 is unvisited rain by level, 4-6 is visited noise, and 7-9 is
  // accepted component rain by level.
  const state = rainState;
  state.fill(0);
  if (fullFrame) {
    for (let k = 0; k < 480 * 480; k++) {
      const pi = k * 4;
      const lvl = rainLevelForColor(data[pi], data[pi + 1], data[pi + 2]);
      if (lvl) state[k] = lvl;
    }
  } else {
    for (let i = 0; i < SG_RAIN_PIXEL_DATA.length; i++) {
      const packed = SG_RAIN_PIXEL_DATA[i];
      const k = packed & RAIN_PIXEL_KEY_MASK;
      const pi = k * 4;
      const lvl = rainLevelForColor(data[pi], data[pi + 1], data[pi + 2]);
      if (lvl) state[k] = lvl;
    }
  }
  // Pass 2: 4-connected flood fill. A component is accepted when it covers
  // at least four orthogonally adjacent pixels; anything smaller is noise.
  const members = rainMembers;
  const seedCount = fullFrame ? 480 * 480 : RAIN_PIXEL_COUNT;
  for (let si = 0; si < seedCount; si++) {
    const seed = fullFrame ? si : SG_RAIN_PIXEL_DATA[si] & RAIN_PIXEL_KEY_MASK;
    if (state[seed] < 1 || state[seed] > 3) continue;
    let memberCount = 1;
    members[0] = seed;
    state[seed] += 3;
    let head = 0;
    while (head < memberCount) {
      const k = members[head++];
      const x = k % W;
      const y = (k - x) / W;
      const left = x > 0 ? k - 1 : -1;
      const right = x + 1 < W ? k + 1 : -1;
      const above = y > 0 ? k - W : -1;
      const below = y + 1 < H ? k + W : -1;
      const area = fullFrame ? 1 : SG_RAIN_PIXEL_AREAS[seed];
      if (
        left >= 0 &&
        state[left] >= 1 &&
        state[left] <= 3 &&
        (fullFrame || SG_RAIN_PIXEL_AREAS[left] === area)
      ) {
        state[left] += 3;
        members[memberCount++] = left;
      }
      if (
        right >= 0 &&
        state[right] >= 1 &&
        state[right] <= 3 &&
        (fullFrame || SG_RAIN_PIXEL_AREAS[right] === area)
      ) {
        state[right] += 3;
        members[memberCount++] = right;
      }
      if (
        above >= 0 &&
        state[above] >= 1 &&
        state[above] <= 3 &&
        (fullFrame || SG_RAIN_PIXEL_AREAS[above] === area)
      ) {
        state[above] += 3;
        members[memberCount++] = above;
      }
      if (
        below >= 0 &&
        state[below] >= 1 &&
        state[below] <= 3 &&
        (fullFrame || SG_RAIN_PIXEL_AREAS[below] === area)
      ) {
        state[below] += 3;
        members[memberCount++] = below;
      }
    }
    if (memberCount >= MIN_COMPONENT_PIXELS) {
      const pixels = new Uint32Array(memberCount);
      const levels = new Uint8Array(memberCount);
      let sumX = 0;
      let sumY = 0;
      let totalLevel = 0;
      for (let m = 0; m < memberCount; m++) {
        const pixel = members[m];
        const level = state[pixel] - 3;
        const x = pixel % W;
        const y = (pixel - x) / W;
        pixels[m] = pixel;
        levels[m] = level;
        sumX += x;
        sumY += y;
        totalLevel += level;
        state[pixel] += 3;
      }
      cells.push({
        pixels,
        levels,
        area: fullFrame ? -1 : SG_RAIN_PIXEL_AREAS[seed] - 1,
        centroidX: sumX / memberCount,
        centroidY: sumY / memberCount,
        totalLevel,
        mass: totalLevel,
      });
    }
  }
  return cells;
}

function analyzeRadar(canvas) {
  const areas = SINGAPORE_AREAS.map(([name, region]) => ({
    name,
    region,
    counts: [0, 0, 0, 0],
  }));
  for (const cell of analyzeRainCells(canvas)) {
    const counts = areas[cell.area].counts;
    for (const level of cell.levels) counts[level]++;
  }
  const rainyAreas = [];
  for (const a of areas) {
    const total = a.counts[1] + a.counts[2] + a.counts[3];
    if (!total) continue;
    const hit = { name: a.name, region: a.region, counts: a.counts, area: total };
    rainyAreas.push(hit);
  }
  return rainyAreas;
}

function cellOverlap(source, targetPixels, targetCount, dx, dy) {
  let overlap = 0;
  for (const pixel of source.pixels) {
    const x = pixel % NOWCAST_SIZE;
    const y = (pixel - x) / NOWCAST_SIZE;
    const tx = x + Math.round(dx);
    const ty = y + Math.round(dy);
    if (tx >= 0 && tx < NOWCAST_SIZE && ty >= 0 && ty < NOWCAST_SIZE) {
      if (targetPixels.has(ty * NOWCAST_SIZE + tx)) overlap++;
    }
  }
  return overlap / Math.min(source.pixels.length, targetCount);
}

function pairCells(source, target) {
  const targetSets = target.map((cell) => new Set(cell.pixels));
  const candidates = [];
  for (let si = 0; si < source.length; si++) {
    for (let ti = 0; ti < target.length; ti++) {
      const a = source[si];
      const b = target[ti];
      const dx = b.centroidX - a.centroidX;
      const dy = b.centroidY - a.centroidY;
      const distance = Math.hypot(dx, dy);
      if (distance > NOWCAST_MATCH_DISTANCE) continue;
      const overlap = cellOverlap(a, targetSets[ti], b.pixels.length, dx, dy);
      if (overlap < NOWCAST_MATCH_OVERLAP && distance > 12) continue;
      candidates.push({ si, ti, dx, dy, distance, overlap });
    }
  }
  candidates.sort((a, b) => b.overlap - a.overlap || a.distance - b.distance);
  const usedSource = new Set();
  const usedTarget = new Set();
  const pairs = [];
  for (const candidate of candidates) {
    if (usedSource.has(candidate.si) || usedTarget.has(candidate.ti)) continue;
    usedSource.add(candidate.si);
    usedTarget.add(candidate.ti);
    pairs.push(candidate);
  }
  return pairs;
}

// Links cells backwards through frame pairs so each current cell gets a
// lineage of per-step displacements and masses. Displacement stats come from
// the median of up to NOWCAST_FRAMES - 1 deltas instead of a single pair, and
// growth is a clamped exponential rate over the lineage's mass history.
function trackCells(lineageCells) {
  const frameCount = lineageCells.length;
  const pairs = [];
  for (let f = 1; f < frameCount; f++) pairs.push(pairCells(lineageCells[f - 1], lineageCells[f]));
  // lineage[ci] holds {cellIndex, frameIndex} entries ordered oldest -> newest.
  const lineages = [];
  const tracks = new Map();
  const lastPair = pairs[pairs.length - 1];
  const fromC = new Map(lastPair.map((p) => [p.ti, p]));
  for (let ci = 0; ci < lineageCells[frameCount - 1].length; ci++) {
    const lineage = [{ cellIndex: ci, frameIndex: frameCount - 1 }];
    let cursor = ci;
    for (let f = pairs.length - 1; f >= 0; f--) {
      const pair = pairs[f].find((p) => p.ti === cursor);
      if (!pair) break;
      cursor = pair.si;
      lineage.push({ cellIndex: cursor, frameIndex: f });
    }
    lineage.reverse();
    lineages.push(lineage);
    const deltas = [];
    const masses = [
      {
        mass: lineageCells[lineage[0].frameIndex][lineage[0].cellIndex].mass,
        frameIndex: lineage[0].frameIndex,
      },
    ];
    for (let e = 1; e < lineage.length; e++) {
      const frameIndex = lineage[e].frameIndex;
      const pair = pairs[frameIndex - 1].find((p) => p.ti === lineage[e].cellIndex);
      if (pair) deltas.push({ dx: pair.dx, dy: pair.dy });
      masses.push({
        mass: lineageCells[frameIndex][lineage[e].cellIndex].mass,
        frameIndex,
      });
    }
    const dxs = deltas.map((d) => d.dx).sort((a, b) => a - b);
    const dys = deltas.map((d) => d.dy).sort((a, b) => a - b);
    const mid = dxs.length >> 1;
    const medianDx = dxs.length
      ? dxs.length % 2
        ? dxs[mid]
        : (dxs[mid - 1] + dxs[mid]) / 2
      : null;
    const medianDy = dys.length
      ? dys.length % 2
        ? dys[mid]
        : (dys[mid - 1] + dys[mid]) / 2
      : null;
    const median = medianDx == null ? null : { dx: medianDx, dy: medianDy };
    let sigma = 0;
    if (median) {
      for (const d of deltas)
        sigma = Math.max(sigma, Math.hypot(d.dx - median.dx, d.dy - median.dy));
    }
    // Growth: exponential mass rate per 5-min step over the lineage, clamped.
    const first = masses[0];
    const last = masses[masses.length - 1];
    let growth = 0;
    if (first && last.mass > 0 && first.mass > 0 && last.frameIndex > first.frameIndex) {
      growth = Math.log(last.mass / first.mass) / (last.frameIndex - first.frameIndex);
      growth = clamp(growth, -NOWCAST_GROWTH_MAX, NOWCAST_GROWTH_MAX);
    }
    const d2Pair = lastPair.find((p) => p.ti === ci);
    // d1 is the step that brought the cell into the second-to-last lineage frame.
    const prev = lineage.length >= 2 ? lineage[lineage.length - 2] : null;
    const d1Pair =
      prev && prev.frameIndex >= 1
        ? pairs[prev.frameIndex - 1].find((p) => p.ti === prev.cellIndex) || null
        : null;
    tracks.set(ci, {
      d1: d1Pair ? { dx: d1Pair.dx, dy: d1Pair.dy } : null,
      d2: d2Pair ? { dx: d2Pair.dx, dy: d2Pair.dy } : null,
      median,
      sigma,
      growth,
      matchedPrevious: deltas.length > 0,
    });
  }
  return { tracks, pairs };
}

function pixelLngLat(pixel) {
  const x = pixel % NOWCAST_SIZE;
  const y = (pixel - x) / NOWCAST_SIZE;
  const bb = RADAR_BOUNDS[70];
  return {
    lng:
      bb.upperLeft.longitude +
      ((x + 0.5) / NOWCAST_SIZE) * (bb.lowerRight.longitude - bb.upperLeft.longitude),
    lat:
      bb.upperLeft.latitude -
      ((y + 0.5) / NOWCAST_SIZE) * (bb.upperLeft.latitude - bb.lowerRight.latitude),
  };
}

function windDisplacement(pixel, steps) {
  const { lng, lat } = pixelLngLat(pixel);
  const w = sampleWind(lng, lat);
  return {
    dx:
      (w.u * steps * 5 * 60) /
      (111320 * Math.cos((lat * Math.PI) / 180)) /
      ((RADAR_BOUNDS[70].lowerRight.longitude - RADAR_BOUNDS[70].upperLeft.longitude) /
        NOWCAST_SIZE),
    dy:
      -(w.v * steps * 5 * 60) /
      110540 /
      ((RADAR_BOUNDS[70].upperLeft.latitude - RADAR_BOUNDS[70].lowerRight.latitude) / NOWCAST_SIZE),
  };
}

function createField(cells, tracks, member, steps, dense = null) {
  const dx = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  const dy = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  for (let ci = 0; ci < cells.length; ci++) {
    const track = tracks.get(ci);
    let velocity = track?.[member];
    const sheet =
      member === 'median' &&
      (cells[ci].pixels.length > NOWCAST_SHEET_PIXELS ||
        track?.sigma > NOWCAST_SHEET_SIGMA ||
        !track?.matchedPrevious);
    if (sheet && dense) velocity = null;
    for (const pixel of cells[ci].pixels) {
      const displacement = velocity
        ? { dx: velocity.dx * steps, dy: velocity.dy * steps }
        : dense && sheet
          ? { dx: dense.dx[pixel] * steps, dy: dense.dy[pixel] * steps }
          : windDisplacement(pixel, steps);
      dx[pixel] = displacement.dx;
      dy[pixel] = displacement.dy;
    }
  }
  return { dx, dy };
}

function fieldForWind(cells, steps) {
  const dx = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  const dy = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  for (const cell of cells) {
    for (const pixel of cell.pixels) {
      const displacement = windDisplacement(pixel, steps);
      dx[pixel] = displacement.dx;
      dy[pixel] = displacement.dy;
    }
  }
  return { dx, dy };
}

// Display-only field: small cells follow their median track; sheets follow the
// smooth wind IDW so they shear. When wind is missing (API 429 / far from
// stations) fall back to low-pass dense — not raw dense, which re-tears.
function createDisplayField(cells, tracks, steps, dense = null) {
  const dx = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  const dy = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  for (let ci = 0; ci < cells.length; ci++) {
    const track = tracks.get(ci);
    const velocity = track?.median;
    const sheet =
      cells[ci].pixels.length > NOWCAST_SHEET_PIXELS ||
      track?.sigma > NOWCAST_SHEET_SIGMA ||
      !track?.matchedPrevious;
    for (const pixel of cells[ci].pixels) {
      if (sheet || !velocity) {
        const w = windDisplacement(pixel, steps);
        if (w.dx * w.dx + w.dy * w.dy < 0.01 && dense) {
          dx[pixel] = dense.dx[pixel] * steps;
          dy[pixel] = dense.dy[pixel] * steps;
        } else {
          dx[pixel] = w.dx;
          dy[pixel] = w.dy;
        }
      } else {
        dx[pixel] = velocity.dx * steps;
        dy[pixel] = velocity.dy * steps;
      }
    }
  }
  return { dx, dy };
}

function advectForward(canvas, cells, field, step, tracks) {
  const src = canvas.getContext('2d').getImageData(0, 0, NOWCAST_SIZE, NOWCAST_SIZE).data;
  const output = new Uint8ClampedArray(src.length);
  const outputLevel = new Uint8Array(NOWCAST_SIZE * NOWCAST_SIZE);
  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci];
    const track = tracks?.get(ci);
    // Per-cell fade: neutral decay, boosted or cancelled by the lineage's
    // clamped mass-growth rate, so intensifying cells stop fading out.
    const growth = track?.growth || 0;
    const fade = clamp(NOWCAST_DECAY * Math.exp(growth), 0.3, 1.2) ** step;
    const shift = growth > 0.25 ? 1 : growth < -0.25 ? -1 : 0;
    for (let m = 0; m < cell.pixels.length; m++) {
      const pixel = cell.pixels[m];
      const x = pixel % NOWCAST_SIZE;
      const y = (pixel - x) / NOWCAST_SIZE;
      const fx = x + field.dx[pixel];
      const fy = y + field.dy[pixel];
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const u = fx - x0;
      const v = fy - y0;
      const level = clamp(cell.levels[m] + shift, 1, 3);
      const so = pixel * 4;
      const r = src[so];
      const g = src[so + 1];
      const b = src[so + 2];
      const a = Math.round(src[so + 3] * fade);
      // Dominant bilinear corner at full alpha (no footprint expansion).
      // Extra corners only when weight is strong (≥0.4) so shear still
      // bridges without every pixel becoming a 2×2 stamp.
      let bestW = 0;
      let bestOx = 0;
      let bestOy = 0;
      const ws = [0, 0, 0, 0];
      let wi = 0;
      for (let oy = 0; oy <= 1; oy++) {
        for (let ox = 0; ox <= 1; ox++) {
          const w = (ox ? u : 1 - u) * (oy ? v : 1 - v);
          ws[wi++] = w;
          if (w > bestW) {
            bestW = w;
            bestOx = ox;
            bestOy = oy;
          }
        }
      }
      wi = 0;
      for (let oy = 0; oy <= 1; oy++) {
        for (let ox = 0; ox <= 1; ox++) {
          const w = ws[wi++];
          const dominant = ox === bestOx && oy === bestOy;
          if (!dominant && w < 0.4) continue;
          if (w <= 0) continue;
          const tx = x0 + ox;
          const ty = y0 + oy;
          if (tx < 0 || tx >= NOWCAST_SIZE || ty < 0 || ty >= NOWCAST_SIZE) continue;
          const dest = ty * NOWCAST_SIZE + tx;
          if (level < outputLevel[dest]) continue;
          const o = dest * 4;
          output[o] = r;
          output[o + 1] = g;
          output[o + 2] = b;
          output[o + 3] = a;
          outputLevel[dest] = level;
        }
      }
    }
  }
  const out = document.createElement('canvas');
  out.width = NOWCAST_SIZE;
  out.height = NOWCAST_SIZE;
  out.getContext('2d').putImageData(new ImageData(output, NOWCAST_SIZE, NOWCAST_SIZE), 0, 0);
  return { canvas: out, levels: outputLevel };
}

// Rain-preserving 3×3 coherence: only delete isolated speckles, fill holes when
// neighbors dominate, snap color to the neighborhood's majority rain level.
// Never turns a connected rain pixel empty — a plain mode filter eats interiors.
function spatialCoherence(canvas, levels) {
  const W = NOWCAST_SIZE;
  const src = canvas.getContext('2d').getImageData(0, 0, W, W);
  const px = src.data;
  let curLevels = levels;
  let curPx = new Uint8ClampedArray(px);
  for (let pass = 0; pass < 2; pass++) {
    const outLevels = curLevels.slice();
    const outPx = curPx.slice();
    for (let y = 1; y < W - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        let n4 = 0;
        let n8 = 0;
        let maxL = 0;
        let maxP = -1;
        let maxA = -1;
        const counts = [0, 0, 0, 0];
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const q = (y + oy) * W + (x + ox);
            const l = curLevels[q];
            counts[l]++;
            if (!l) continue;
            if (ox === 0 && oy === 0) continue;
            n8++;
            if (ox === 0 || oy === 0) n4++;
            const a = curPx[q * 4 + 3];
            if (l > maxL || (l === maxL && a > maxA)) {
              maxL = l;
              maxP = q;
              maxA = a;
            }
          }
        }
        const self = curLevels[p];
        if (self) {
          if (n4 === 0) {
            outLevels[p] = 0;
            outPx[p * 4] = outPx[p * 4 + 1] = outPx[p * 4 + 2] = outPx[p * 4 + 3] = 0;
            continue;
          }
          let modeL = 0;
          let modeC = 0;
          for (let l = 3; l >= 1; l--) {
            if (counts[l] > modeC || (counts[l] === modeC && l > modeL)) {
              modeC = counts[l];
              modeL = l;
            }
          }
          if (modeL && modeL !== self) {
            let srcP = -1;
            for (let oy = -1; oy <= 1 && srcP < 0; oy++) {
              for (let ox = -1; ox <= 1; ox++) {
                const q = (y + oy) * W + (x + ox);
                if (curLevels[q] === modeL) {
                  srcP = q;
                  break;
                }
              }
            }
            if (srcP >= 0) {
              outLevels[p] = modeL;
              outPx[p * 4] = curPx[srcP * 4];
              outPx[p * 4 + 1] = curPx[srcP * 4 + 1];
              outPx[p * 4 + 2] = curPx[srcP * 4 + 2];
              outPx[p * 4 + 3] = Math.max(curPx[p * 4 + 3], curPx[srcP * 4 + 3]);
            }
          }
        } else if ((n8 >= 5 && maxL >= 2) || (n4 >= 2 && n8 >= 4 && maxL >= 2)) {
          outLevels[p] = maxL;
          if (maxP >= 0) {
            outPx[p * 4] = curPx[maxP * 4];
            outPx[p * 4 + 1] = curPx[maxP * 4 + 1];
            outPx[p * 4 + 2] = curPx[maxP * 4 + 2];
            outPx[p * 4 + 3] = curPx[maxP * 4 + 3];
          }
        }
      }
    }
    curLevels = outLevels;
    curPx = outPx;
  }
  const out = document.createElement('canvas');
  out.width = W;
  out.height = W;
  out.getContext('2d').putImageData(new ImageData(curPx, W, W), 0, 0);
  return { canvas: out, levels: curLevels };
}

// Binary morphological close seals multi-pixel holes that 3×3 fills miss
// after sheared advection. Dilate-then-erode restores outer shape.
function fillHoles(canvas, levels, radius = 2) {
  const W = NOWCAST_SIZE;
  const px = canvas.getContext('2d').getImageData(0, 0, W, W).data;
  const mask = new Uint8Array(W * W);
  for (let i = 0; i < mask.length; i++) mask[i] = levels[i] ? 1 : 0;
  const dil = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let m = 0;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(W - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(W - 1, x + radius);
      outer: for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (mask[yy * W + xx]) {
            m = 1;
            break outer;
          }
        }
      }
      dil[y * W + x] = m;
    }
  }
  const closed = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let m = 1;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(W - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(W - 1, x + radius);
      outer: for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (!dil[yy * W + xx]) {
            m = 0;
            break outer;
          }
        }
      }
      closed[y * W + x] = m;
    }
  }
  const outLevels = levels.slice();
  const outPx = new Uint8ClampedArray(px);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (levels[p] || !closed[p]) continue;
      // Inverse-distance weighted colors so filled gaps blend with the rim
      // instead of stamping one neighbor's color as a flat rectangle.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let lAcc = 0;
      let wSum = 0;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(W - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(W - 1, x + radius);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const q = yy * W + xx;
          if (!levels[q]) continue;
          const dy = yy - y;
          const dx = xx - x;
          const w = 1 / (dy * dy + dx * dx + 0.25);
          r += px[q * 4] * w;
          g += px[q * 4 + 1] * w;
          b += px[q * 4 + 2] * w;
          a += px[q * 4 + 3] * w;
          lAcc += levels[q] * w;
          wSum += w;
        }
      }
      if (wSum <= 0) continue;
      outLevels[p] = clamp(Math.round(lAcc / wSum), 1, 3);
      outPx[p * 4] = r / wSum;
      outPx[p * 4 + 1] = g / wSum;
      outPx[p * 4 + 2] = b / wSum;
      outPx[p * 4 + 3] = a / wSum;
    }
  }
  const out = document.createElement('canvas');
  out.width = W;
  out.height = W;
  out.getContext('2d').putImageData(new ImageData(outPx, W, W), 0, 0);
  return { canvas: out, levels: outLevels };
}

// Flood empty space from the image border; anything empty still unvisited is
// an enclosed hole (including large axis-aligned voids). Fills those with
// IDW rim colors without touching open exterior.
function fillEnclosedHoles(canvas, levels) {
  const W = NOWCAST_SIZE;
  const px = canvas.getContext('2d').getImageData(0, 0, W, W).data;
  const emptyOpen = new Uint8Array(W * W);
  const queue = new Int32Array(W * W);
  let qn = 0;
  const seed = (p) => {
    if (levels[p] || emptyOpen[p]) return;
    emptyOpen[p] = 1;
    queue[qn++] = p;
  };
  for (let x = 0; x < W; x++) {
    seed(x);
    seed((W - 1) * W + x);
  }
  for (let y = 0; y < W; y++) {
    seed(y * W);
    seed(y * W + (W - 1));
  }
  let head = 0;
  while (head < qn) {
    const p = queue[head++];
    const x = p % W;
    const y = (p - x) / W;
    if (x > 0) seed(p - 1);
    if (x + 1 < W) seed(p + 1);
    if (y > 0) seed(p - W);
    if (y + 1 < W) seed(p + W);
  }
  let curLevels = levels.slice();
  let curPx = new Uint8ClampedArray(px);
  // Grow inward so deep interior pixels pick up already-filled rim colors.
  for (let pass = 0; pass < 48; pass++) {
    const outLevels = curLevels.slice();
    const outPx = curPx.slice();
    let filled = 0;
    for (let y = 1; y < W - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (curLevels[p] || emptyOpen[p]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let lAcc = 0;
        let wSum = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const q = (y + oy) * W + (x + ox);
            const l = curLevels[q];
            if (!l) continue;
            const w = 1 / (ox * ox + oy * oy + 0.25);
            r += curPx[q * 4] * w;
            g += curPx[q * 4 + 1] * w;
            b += curPx[q * 4 + 2] * w;
            a += curPx[q * 4 + 3] * w;
            lAcc += l * w;
            wSum += w;
          }
        }
        if (wSum <= 0) continue;
        outLevels[p] = clamp(Math.round(lAcc / wSum), 1, 3);
        outPx[p * 4] = r / wSum;
        outPx[p * 4 + 1] = g / wSum;
        outPx[p * 4 + 2] = b / wSum;
        outPx[p * 4 + 3] = a / wSum;
        filled++;
      }
    }
    curLevels = outLevels;
    curPx = outPx;
    if (!filled) break;
  }
  const out = document.createElement('canvas');
  out.width = W;
  out.height = W;
  out.getContext('2d').putImageData(new ImageData(curPx, W, W), 0, 0);
  return { canvas: out, levels: curLevels };
}

// Drop diagonal-only speckles and fill 1-px holes inside rain. Keeps real
// edges intact — unlike a plain dilate/erode close, which inflates blobs.
function cleanBlend(blend) {
  const W = NOWCAST_SIZE;
  const { levels, canvas } = blend;
  const data = canvas.getContext('2d').getImageData(0, 0, W, W);
  const px = data.data;
  const outLevels = levels.slice();
  const outPx = new Uint8ClampedArray(px);
  for (let y = 1; y < W - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      let n4 = 0;
      let n8 = 0;
      let maxL = 0;
      let maxP = -1;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const q = (y + oy) * W + (x + ox);
          const l = levels[q];
          if (!l) continue;
          if (ox === 0 && oy === 0) {
            maxL = l;
            maxP = q;
            continue;
          }
          n8++;
          if (ox === 0 || oy === 0) n4++;
          if (l > maxL) {
            maxL = l;
            maxP = q;
          }
        }
      }
      const self = levels[p];
      if (self) {
        if (n4 === 0) {
          outLevels[p] = 0;
          outPx[p * 4] = outPx[p * 4 + 1] = outPx[p * 4 + 2] = outPx[p * 4 + 3] = 0;
        }
      } else if (n4 >= 2 && n8 >= 4 && maxP >= 0) {
        outLevels[p] = maxL;
        outPx[p * 4] = px[maxP * 4];
        outPx[p * 4 + 1] = px[maxP * 4 + 1];
        outPx[p * 4 + 2] = px[maxP * 4 + 2];
        outPx[p * 4 + 3] = px[maxP * 4 + 3];
      }
    }
  }
  canvas.getContext('2d').putImageData(new ImageData(outPx, W, W), 0, 0);
  blend.levels = outLevels;
  return blend;
}

function maxBlend(members) {
  const output = new Uint8ClampedArray(NOWCAST_SIZE * NOWCAST_SIZE * 4);
  const outputLevel = new Uint8Array(NOWCAST_SIZE * NOWCAST_SIZE);
  for (const member of members) {
    const data = member.canvas.getContext('2d').getImageData(0, 0, NOWCAST_SIZE, NOWCAST_SIZE).data;
    for (let pixel = 0; pixel < outputLevel.length; pixel++) {
      const level = member.levels[pixel];
      // First member wins ties so median colors beat the noisier dense member.
      if (!level || level <= outputLevel[pixel]) continue;
      const so = pixel * 4;
      output.set(data.subarray(so, so + 4), so);
      outputLevel[pixel] = level;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = NOWCAST_SIZE;
  canvas.height = NOWCAST_SIZE;
  canvas.getContext('2d').putImageData(new ImageData(output, NOWCAST_SIZE, NOWCAST_SIZE), 0, 0);
  const cleaned = cleanBlend({ canvas, levels: outputLevel });
  return spatialCoherence(cleaned.canvas, cleaned.levels);
}

function areaAtPixel(pixel) {
  if (pixel < 0 || pixel >= SG_RAIN_PIXEL_AREAS.length) return -1;
  return SG_RAIN_PIXEL_AREAS[pixel] - 1;
}

function areaVotes(members) {
  const votes = new Uint8Array(SINGAPORE_AREAS.length);
  for (const member of members) {
    const seen = new Uint8Array(SINGAPORE_AREAS.length);
    for (const packed of SG_RAIN_PIXEL_DATA) {
      const pixel = packed & RAIN_PIXEL_KEY_MASK;
      if (!member.levels[pixel]) continue;
      const area = areaAtPixel(pixel);
      if (area >= 0) seen[area] = 1;
    }
    for (let i = 0; i < seen.length; i++) votes[i] += seen[i];
  }
  return votes;
}

// Max-pools a level field over a square neighborhood so a near-miss forecast
// still scores: pixel-exact Jaccard zeroes out on small advection errors.
function neighborhoodMax(levels, radius) {
  const tmp = new Uint8Array(levels.length);
  const out = new Uint8Array(levels.length);
  for (let y = 0; y < NOWCAST_SIZE; y++) {
    const row = y * NOWCAST_SIZE;
    for (let x = 0; x < NOWCAST_SIZE; x++) {
      let m = 0;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(NOWCAST_SIZE - 1, x + radius);
      for (let xx = x0; xx <= x1; xx++) {
        const v = levels[row + xx];
        if (v > m) m = v;
      }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < NOWCAST_SIZE; x++) {
    for (let y = 0; y < NOWCAST_SIZE; y++) {
      let m = 0;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(NOWCAST_SIZE - 1, y + radius);
      for (let yy = y0; yy <= y1; yy++) {
        const v = tmp[yy * NOWCAST_SIZE + x];
        if (v > m) m = v;
      }
      out[y * NOWCAST_SIZE + x] = m;
    }
  }
  return out;
}

function pooledScore(aPool, bPool) {
  let intersection = 0;
  let union = 0;
  for (let pixel = 0; pixel < aPool.length; pixel++) {
    const ar = aPool[pixel] > 0;
    const br = bPool[pixel] > 0;
    if (ar && br) intersection++;
    if (ar || br) union++;
  }
  return union ? intersection / union : null;
}

// b is always the actual-rain side; frames with too little real rain to judge
// a forecast return null so they never inflate the rolling fit.
function jaccardRain(a, b) {
  let actual = 0;
  for (let pixel = 0; pixel < b.levels.length; pixel++) if (b.levels[pixel]) actual++;
  if (actual < NOWCAST_FIT_MIN_PIXELS) return null;
  return pooledScore(
    neighborhoodMax(a.levels, NOWCAST_FIT_POOL),
    neighborhoodMax(b.levels, NOWCAST_FIT_POOL),
  );
}

// Breaks up the nowcast's synchronous CPU work so paint stays responsive.
const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

// Search offsets smallest-magnitude first: texture-less blocks score 0 at
// every offset, and without this ordering they'd match the first tried
// offset (-12, -12) — phantom max motion that shreds uniform cells.
const DENSE_OFFSETS = (() => {
  const list = [];
  for (let oy = -12; oy <= 12; oy++)
    for (let ox = -12; ox <= 12; ox++) list.push([ox, oy, ox * ox + oy * oy]);
  return list.sort((p, q) => p[2] - q[2]).map(([ox, oy]) => [ox, oy]);
})();

async function estimateDenseFlow(canvasB, canvasC, generation) {
  const downsample = (canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, NOWCAST_SIZE, NOWCAST_SIZE).data;
    const field = new Uint8Array(240 * 240);
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 240; x++) {
        let level = 0;
        for (let oy = 0; oy < 2; oy++) {
          for (let ox = 0; ox < 2; ox++) {
            const p = ((y * 2 + oy) * NOWCAST_SIZE + x * 2 + ox) * 4;
            level = Math.max(level, rainLevelForColor(data[p], data[p + 1], data[p + 2]));
          }
        }
        field[y * 240 + x] = level;
      }
    }
    return field;
  };
  const a = downsample(canvasB);
  const b = downsample(canvasC);
  const bw = 40;
  const bh = 40;
  const flowX = new Float32Array(bw * bh);
  const flowY = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    if (by && by % 8 === 0) {
      await yieldToUI();
      if (generation !== nowcastGeneration) return null;
    }
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * 6;
      const y0 = by * 6;
      let best = Infinity;
      let bestX = 0;
      let bestY = 0;
      for (const [ox, oy] of DENSE_OFFSETS) {
        if (x0 + ox < 0 || y0 + oy < 0 || x0 + ox + 5 >= 240 || y0 + oy + 5 >= 240) continue;
        let score = 0;
        for (let y = 0; y < 6; y++) {
          for (let x = 0; x < 6; x++)
            score += Math.abs(a[(y0 + y) * 240 + x0 + x] - b[(y0 + oy + y) * 240 + x0 + ox]);
        }
        if (score < best) {
          best = score;
          bestX = ox;
          bestY = oy;
          if (!best) break;
        }
      }
      flowX[by * bw + bx] = bestX;
      flowY[by * bw + bx] = bestY;
    }
  }
  const dx = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  const dy = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  for (let y = 0; y < NOWCAST_SIZE; y++) {
    const gy = y / 12;
    const y0 = Math.min(bh - 1, gy | 0);
    const y1 = Math.min(bh - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < NOWCAST_SIZE; x++) {
      const gx = x / 12;
      const x0 = Math.min(bw - 1, gx | 0);
      const x1 = Math.min(bw - 1, x0 + 1);
      const fx = gx - x0;
      const i00 = y0 * bw + x0;
      const i10 = y0 * bw + x1;
      const i01 = y1 * bw + x0;
      const i11 = y1 * bw + x1;
      dx[y * NOWCAST_SIZE + x] =
        ((flowX[i00] * (1 - fx) + flowX[i10] * fx) * (1 - fy) +
          (flowX[i01] * (1 - fx) + flowX[i11] * fx) * fy) *
        2;
      dy[y * NOWCAST_SIZE + x] =
        ((flowY[i00] * (1 - fx) + flowY[i10] * fx) * (1 - fy) +
          (flowY[i01] * (1 - fx) + flowY[i11] * fx) * fy) *
        2;
    }
  }
  // Low-pass the flow: 4× box average then bilinear upsample. A few 3×3
  // Gaussians leave 12-px block-grid tears; this removes block structure
  // while keeping large-scale shear so cells deform instead of sliding.
  const lw = NOWCAST_SIZE / 4;
  const lx = new Float32Array(lw * lw);
  const ly = new Float32Array(lw * lw);
  for (let y = 0; y < lw; y++) {
    for (let x = 0; x < lw; x++) {
      let sx = 0;
      let sy = 0;
      for (let oy = 0; oy < 4; oy++) {
        for (let ox = 0; ox < 4; ox++) {
          const p = (y * 4 + oy) * NOWCAST_SIZE + (x * 4 + ox);
          sx += dx[p];
          sy += dy[p];
        }
      }
      lx[y * lw + x] = sx / 16;
      ly[y * lw + x] = sy / 16;
    }
  }
  const outX = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  const outY = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  for (let y = 0; y < NOWCAST_SIZE; y++) {
    const gy = y / 4;
    const y0 = Math.min(lw - 1, gy | 0);
    const y1 = Math.min(lw - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < NOWCAST_SIZE; x++) {
      const gx = x / 4;
      const x0 = Math.min(lw - 1, gx | 0);
      const x1 = Math.min(lw - 1, x0 + 1);
      const fx = gx - x0;
      const i00 = y0 * lw + x0;
      const i10 = y0 * lw + x1;
      const i01 = y1 * lw + x0;
      const i11 = y1 * lw + x1;
      const p = y * NOWCAST_SIZE + x;
      outX[p] =
        (lx[i00] * (1 - fx) + lx[i10] * fx) * (1 - fy) + (lx[i01] * (1 - fx) + lx[i11] * fx) * fy;
      outY[p] =
        (ly[i00] * (1 - fx) + ly[i10] * fx) * (1 - fy) + (ly[i01] * (1 - fx) + ly[i11] * fx) * fy;
    }
  }
  return { dx: outX, dy: outY };
}

function staticMember(canvas, cells) {
  const levels = new Uint8Array(NOWCAST_SIZE * NOWCAST_SIZE);
  for (const cell of cells) {
    for (let i = 0; i < cell.pixels.length; i++) levels[cell.pixels[i]] = cell.levels[i];
  }
  return { canvas, levels };
}

function denseFieldForCells(cells, dense, steps) {
  const dx = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  const dy = new Float32Array(NOWCAST_SIZE * NOWCAST_SIZE);
  for (const cell of cells) {
    for (const pixel of cell.pixels) {
      dx[pixel] = dense.dx[pixel] * steps;
      dy[pixel] = dense.dy[pixel] * steps;
    }
  }
  return { dx, dy };
}

function shortHash(values) {
  let hash = 2166136261;
  for (const value of values) {
    const text = String(Math.round(value * 10) / 10);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash >>> 0).toString(36).slice(0, 8);
}

function newestLiveSlot(range) {
  let latest = -Infinity;
  for (const [slot, frame] of framesMap[range] || [])
    if (!frame.nowcast && slot > latest) latest = slot;
  return latest;
}

function forecastAreaHits(entry) {
  const areas = SINGAPORE_AREAS.map(([name, region]) => ({
    name,
    region,
    counts: [0, 0, 0, 0],
  }));
  for (const packed of SG_RAIN_PIXEL_DATA) {
    const pixel = packed & RAIN_PIXEL_KEY_MASK;
    const level = entry.maxBlendLevels[pixel];
    if (level) areas[packed >>> 18].counts[level]++;
  }
  return areas
    .map((area, index) => ({
      ...area,
      area: area.counts[1] + area.counts[2] + area.counts[3],
      votes: entry.votes[index],
    }))
    .filter((area) => area.area && area.votes >= 2);
}

function hasForecastRain(entry) {
  for (const packed of SG_RAIN_PIXEL_DATA) {
    if (entry.maxBlendLevels[packed & RAIN_PIXEL_KEY_MASK]) return true;
  }
  return false;
}

function forecastLightningHints(cells, tracks, step) {
  if (!lightningStrikes.length) return [];
  const now = Date.now();
  const incoming = new Set();
  for (let i = 0; i < cells.length; i++) {
    const track = tracks.get(i);
    if (!track?.median) continue;
    const cell = cells[i];
    const x = Math.round(cell.centroidX + track.median.dx * step);
    const y = Math.round(cell.centroidY + track.median.dy * step);
    if (x >= 0 && x < NOWCAST_SIZE && y >= 0 && y < NOWCAST_SIZE) {
      const area = areaAtPixel(y * NOWCAST_SIZE + x);
      if (area >= 0) incoming.add(area);
    }
  }
  const hinted = new Set();
  for (const strike of lightningStrikes) {
    if (strike.t <= now - LIGHTNING_MAX_AGE || strike.t > now) continue;
    const bb = RADAR_BOUNDS[70];
    const x = Math.floor(
      ((strike.lng - bb.upperLeft.longitude) / (bb.lowerRight.longitude - bb.upperLeft.longitude)) *
        NOWCAST_SIZE,
    );
    const y = Math.floor(
      ((bb.upperLeft.latitude - strike.lat) / (bb.upperLeft.latitude - bb.lowerRight.latitude)) *
        NOWCAST_SIZE,
    );
    const area = areaAtPixel(y * NOWCAST_SIZE + x);
    if (area >= 0 && !incoming.has(area)) hinted.add(area);
  }
  return [...hinted];
}

// Scores each ensemble member's +5 min forecast for a slot against the live
// frame that just arrived for that slot; logs per-member pooled Jaccard.
function scoreMembers(actualSlot, entry) {
  const frame = framesMap[70]?.get(actualSlot);
  if (!entry?.members || entry.scored || !frame || frame.nowcast) return;
  entry.scored = true;
  prepareFrameImage(70, frame)
    .then((canvas) => {
      const actualLevels = new Uint8Array(NOWCAST_SIZE * NOWCAST_SIZE);
      for (const cell of analyzeRainCells(canvas, true))
        for (let i = 0; i < cell.pixels.length; i++) actualLevels[cell.pixels[i]] = cell.levels[i];
      const actualPool = neighborhoodMax(actualLevels, NOWCAST_FIT_POOL);
      const names = ['median', 'd1', 'd2', 'wind', 'dense'];
      const parts = entry.members.map((levels, i) => {
        const s = pooledScore(neighborhoodMax(levels, NOWCAST_FIT_POOL), actualPool);
        return `${names[i]}=${s == null ? 'n/a' : `${Math.round(s * 100)}%`}`;
      });
      console.log(`nowcast members @+5min: ${parts.join(' ')}`);
    })
    .catch(() => {});
}

function modelFitPercent() {
  const cutoff = Date.now() - NOWCAST_FIT_MAX_AGE;
  while (nowcastFitSamples.length && nowcastFitSamples[0].t < cutoff) nowcastFitSamples.shift();
  if (!nowcastFitSamples.length) return null;
  return Math.round(
    (nowcastFitSamples.reduce((sum, sample) => sum + sample.j, 0) / nowcastFitSamples.length) * 100,
  );
}

function recomputeNowcast() {
  const generation = ++nowcastGeneration;
  // The +5 min forecast made one slot ago targets the current live slot; keep
  // its entry alive for member scoring before clear() wipes the maps.
  const previousSlot = newestLiveSlot(70);
  const previousEntry = nowcastCanvases.get(previousSlot);
  const clear = () => {
    nowcastCanvases.clear();
    if (framesMap[70]) {
      for (const [slot, frame] of framesMap[70]) if (frame.nowcast) framesMap[70].delete(slot);
    }
    if (framesByRange[70]) framesByRange[70] = framesByRange[70].filter((frame) => !frame.nowcast);
    summaryShownKey = null;
  };
  const redraw = () => {
    const newSlots = rebuildTimeline();
    updateSlider(newSlots);
    if (allTimestamps.length) showFrame(currentIndex);
  };
  clear();
  const latest70 = newestLiveSlot(70);
  const latestGlobal = Math.max(...RANGES.map((range) => newestLiveSlot(range)));
  if (
    !showNowcast ||
    !Number.isFinite(latest70) ||
    Date.now() - latest70 > 10 * 60 * 1000 ||
    latest70 !== latestGlobal
  ) {
    redraw();
    return Promise.resolve();
  }
  const liveFrames = [...(framesMap[70] || [])]
    .filter(([, frame]) => !frame.nowcast)
    .sort((a, b) => a[0] - b[0])
    .slice(-NOWCAST_FRAMES)
    .map(([, frame]) => frame);
  if (liveFrames.length < 3) {
    redraw();
    return Promise.resolve();
  }
  const frames = liveFrames;
  const run = Promise.all(frames.map((frame) => prepareFrameImage(70, frame)))
    .then(async (canvases) => {
      if (generation !== nowcastGeneration) return;
      const canvasC = canvases[canvases.length - 1];
      const canvasB = canvases[canvases.length - 2];
      // Cells over the whole 70 km frame (sea and Johor included) so the
      // forecast tracks weather approaching from outside Singapore.
      const lineageCells = canvases.map((canvas) => analyzeRainCells(canvas, true));
      const cellsC = lineageCells[lineageCells.length - 1];
      const { tracks, pairs } = trackCells(lineageCells);
      const dense = await estimateDenseFlow(canvasB, canvasC, generation);
      if (!dense || generation !== nowcastGeneration) return;
      const hashValues = [];
      for (const track of tracks.values()) {
        if (track.median) hashValues.push(track.median.dx, track.median.dy);
      }
      const seed = shortHash(hashValues);
      scoreMembers(latest70, previousEntry);
      // One-step validation: advect the second-to-last frame by the velocity
      // that brought its cells in, then pooled-score against the actual frame.
      const cellsB = lineageCells[lineageCells.length - 2];
      const velocityPair = pairs[pairs.length - 2] || pairs[pairs.length - 1];
      const validationTracks = new Map();
      for (const pair of velocityPair)
        validationTracks.set(pair.ti, { d1: { dx: pair.dx, dy: pair.dy } });
      const validation = advectForward(
        canvasB,
        cellsB,
        createField(cellsB, validationTracks, 'd1', 1),
        1,
        null,
      );
      const j = jaccardRain(validation, staticMember(canvasC, cellsC));
      if (j != null) {
        nowcastFitSamples.push({ t: Date.now(), j });
        while (nowcastFitSamples.length > NOWCAST_FIT_MAX_SAMPLES) nowcastFitSamples.shift();
      }
      for (let step = 1; step <= 3; step++) {
        if (step > 1) {
          await yieldToUI();
          if (generation !== nowcastGeneration) return;
        }
        const m0 = advectForward(
          canvasC,
          cellsC,
          createField(cellsC, tracks, 'median', step, dense),
          step,
          tracks,
        );
        const displaySource = advectForward(
          canvasC,
          cellsC,
          createDisplayField(cellsC, tracks, step, dense),
          step,
          tracks,
        );
        const m1 = advectForward(
          canvasC,
          cellsC,
          createField(cellsC, tracks, 'd1', step),
          step,
          tracks,
        );
        const m2 = advectForward(
          canvasC,
          cellsC,
          createField(cellsC, tracks, 'd2', step),
          step,
          tracks,
        );
        const m3 = advectForward(canvasC, cellsC, fieldForWind(cellsC, step), step, tracks);
        const m4 = advectForward(
          canvasC,
          cellsC,
          denseFieldForCells(cellsC, dense, step),
          step,
          tracks,
        );
        const blend = maxBlend([m0, m1, m2, m3, m4]);
        const group = [m0, m1, m2, m3, m4];
        const coherent = spatialCoherence(displaySource.canvas, displaySource.levels);
        // Seal tiny gaps first so large voids count as enclosed, then fill them.
        const smallGaps = fillHoles(coherent.canvas, coherent.levels);
        const entry = {
          display: fillEnclosedHoles(smallGaps.canvas, smallGaps.levels).canvas,
          maxBlend: blend.canvas,
          maxBlendLevels: blend.levels,
          votes: areaVotes(group),
          hints: forecastLightningHints(cellsC, tracks, step),
          members: group.map((m) => m.levels),
        };
        const slot = latest70 + step * SLOT_MS;
        nowcastCanvases.set(slot, entry);
        framesMap[70].set(slot, {
          url: `nowcast:${slot}:${seed}`,
          timestamp: new Date(slot).toISOString(),
          nowcast: true,
        });
      }
      framesByRange[70] = [...framesMap[70].values()].sort(
        (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
      );
      redraw();
      if (nowcastControlButton) {
        const fit = modelFitPercent();
        const fitText = fit == null ? 'model fit pending' : `model fit ${fit}% (rolling 1 h)`;
        nowcastControlButton.title = `${fitText} · short-range rain estimate`;
      }
    })
    .catch((error) => {
      if (generation === nowcastGeneration) {
        console.error('Nowcast error:', error);
        redraw();
      }
    });
  return run;
}

function joinList(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} & ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} & ${items[items.length - 1]}`;
}

// Report the heaviest rain that still covers a real share of the rain area, so a
// heavy core isn't diluted to moderate by its own light fringe (a plain average does that).
function dominantLevel(areas) {
  const totals = [0, 0, 0, 0];
  let total = 0;
  for (const h of areas)
    for (let l = 1; l <= 3; l++) {
      totals[l] += h.counts[l];
      total += h.counts[l];
    }
  let cum = 0;
  for (let l = 3; l >= 1; l--) {
    cum += totals[l];
    if (total && cum >= total / 3) return l;
  }
  return 1;
}

function summarizeRain(hits) {
  if (!hits.length) return null;
  const topArea = Math.max(...hits.map((h) => h.area));
  const areas = hits.filter((h) => h.area >= topArea * 0.34);
  const word = LEVEL_WORDS[dominantLevel(areas)];
  const regionCount = {};
  for (const a of areas) regionCount[a.region] = (regionCount[a.region] || 0) + 1;
  const allRegions = Object.keys(regionCount);
  if (areas.length >= Math.ceil(SINGAPORE_AREAS.length / 2) || allRegions.length > 3) {
    return `${word} rain across Singapore.`;
  }
  const groupedRegions = allRegions.filter((r) => regionCount[r] >= (areas.length > 3 ? 2 : 3));
  const named = areas.filter((a) => !groupedRegions.includes(a.region)).map((a) => a.name);
  const parts = [];
  const regionLabels = groupedRegions.map((r) => REGION_LABELS[r]);
  if (groupedRegions.length && named.length) {
    // A mixed phrase is shorter and clearer than separate region/area clauses.
    const suffix = groupedRegions.length === 1 ? 'region' : 'regions';
    parts.push(`around ${joinList(named.slice(0, 2).concat(regionLabels))} ${suffix}`);
  } else if (groupedRegions.length) {
    const prefix = groupedRegions.length === 1 ? 'in' : 'across';
    const suffix = groupedRegions.length === 1 ? 'region' : 'regions';
    parts.push(`${prefix} ${joinList(regionLabels)} ${suffix}`);
  } else if (named.length) {
    const names =
      named.length > 3 ? named.slice(0, 2).concat([`${named.length - 2} others`]) : named;
    parts.push(`around ${joinList(names)}`);
  }
  return `${word} rain ${parts.join(' & ')}.`;
}

function summarizeForecast(entry, minutes) {
  const hits = forecastAreaHits(entry);
  if (!hits.length) return null;
  let text = summarizeRain(hits).replace(/\.$/, '');
  if (entry.hints?.length) {
    const names = entry.hints.map((index) => SINGAPORE_AREAS[index]?.[0]).filter(Boolean);
    if (names.length)
      text += `; lightning hint: possible new shower around ${joinList(names.slice(0, 3))}`;
  }
  return `In ${minutes} min — ${text}.`;
}

let summaryRequest = 0;
let summaryShownKey = null;

function updateRainSummary() {
  const el = document.getElementById('rain-summary');
  const ts = allTimestamps[currentIndex] ? new Date(allTimestamps[currentIndex]).getTime() : null;
  const frame = ts != null ? framesMap[70]?.get(ts) : null;
  const key =
    frame && !failedImages.has(frame.url) ? frameImageKey(70, frame, clipBoundaries) : null;
  if (key === summaryShownKey) return;
  const req = ++summaryRequest;
  if (!key) {
    summaryShownKey = null;
    el.textContent = '';
    el.classList.remove('show');
    return;
  }
  if (frame.nowcast) {
    const entry = nowcastCanvases.get(ts);
    const minutes = Math.max(5, Math.round((ts - newestLiveSlot(70)) / 60000));
    summaryShownKey = key;
    const text = entry ? summarizeForecast(entry, minutes) : null;
    el.textContent = text || '';
    el.classList.toggle('show', Boolean(text));
    return;
  }
  const promise = frameImageCache.get(key) || prepareFrameImage(70, frame);
  promise
    .then((canvas) => {
      if (req !== summaryRequest) return;
      summaryShownKey = key;
      const rainyAreas = analyzeRadar(canvas);
      const text = rainyAreas.length ? summarizeRain(rainyAreas) : null;
      el.textContent = text || '';
      el.classList.toggle('show', !!text);
    })
    .catch(() => {});
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
  if (playbackTimer) setPlayback(false);
  scheduleCommit(tickIndexFromX(e.clientX));
});
sliderTicks.addEventListener('pointerdown', (e) => {
  if (allTimestamps.length < 2) return;
  setPlayback(false);
  commitIndexNow(tickIndexFromX(e.clientX));
});
timeSlider.addEventListener('pointermove', () => {
  if (playbackTimer) setPlayback(false);
});
timeSlider.addEventListener('input', (e) => {
  setPlayback(false);
  scheduleCommit(parseInt(e.target.value));
});
timeSlider.addEventListener('change', (e) => {
  setPlayback(false);
  commitIndexNow(parseInt(e.target.value));
});
timeSlider.addEventListener('pointerup', () => {
  setPlayback(false);
  commitIndexNow(parseInt(timeSlider.value));
});
timeSlider.addEventListener('keyup', () => {
  setPlayback(false);
  commitIndexNow(parseInt(timeSlider.value));
});
timeSlider.addEventListener('pointermove', (e) => {
  if (allTimestamps.length < 2) return;
  const rect = timeSlider.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const index = Math.round(ratio * (allTimestamps.length - 1));
  scheduleCommit(index);
});

const playbackButton = document.getElementById('playback-btn');
function setPlayback(on) {
  clearInterval(playbackTimer);
  playbackTimer = on
    ? setInterval(() => {
        if (allTimestamps.length < 2) return;
        commitIndex((currentIndex + 1) % allTimestamps.length);
      }, 1000)
    : null;
  playbackButton.setAttribute('aria-pressed', String(on));
  playbackButton.setAttribute('aria-label', on ? 'Stop radar timeline' : 'Play radar timeline');
  playbackButton.title = on ? 'Stop radar timeline' : 'Play radar timeline';
}
playbackButton.addEventListener('click', () => {
  if (allTimestamps.length < 2) return;
  setPlayback(!playbackTimer);
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
  if (showNowcast && nowcastCanvases.size) updateSliderCutoff();
}

pruneApiCache();
initMap();
fetchAtSlot();
restartCountdown();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (showWind || showNowcast) loadWind({ forNowcast: showNowcast });
  if (pollRanges.length) pollOnce();
  else if (Date.now() - lastFetchStart > SLOT_MS) fetchAtSlot();
});
setInterval(tickCountdown, 1000);
