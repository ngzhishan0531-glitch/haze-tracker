/* Shared logic for the page and the service worker (loaded via <script> and importScripts). */
(function (g) {
  'use strict';

  const API = 'https://api-open.data.gov.sg/v2/real-time/api';
  const REGIONS = ['central', 'north', 'south', 'east', 'west'];
  const METRICS = {
    psi24: { label: '24-hr PSI', unit: '' },
    pm1: { label: '1-hr PM2.5', unit: ' µg/m³' },
  };
  const DEFAULT_SETTINGS = { region: 'national', metric: 'psi24', threshold: 100, enabled: false };

  // NEA 24-hr PSI bands
  function psiBand(v) {
    if (v == null) return { label: 'No data', cls: 'na' };
    if (v <= 50) return { label: 'Good', cls: 'good' };
    if (v <= 100) return { label: 'Moderate', cls: 'moderate' };
    if (v <= 200) return { label: 'Unhealthy', cls: 'unhealthy' };
    if (v <= 300) return { label: 'Very unhealthy', cls: 'very' };
    return { label: 'Hazardous', cls: 'hazard' };
  }

  // NEA 1-hr PM2.5 bands (µg/m³)
  function pmBand(v) {
    if (v == null) return { label: 'No data', cls: 'na' };
    if (v <= 55) return { label: 'Normal', cls: 'good' };
    if (v <= 150) return { label: 'Elevated', cls: 'unhealthy' };
    if (v <= 250) return { label: 'High', cls: 'very' };
    return { label: 'Very high', cls: 'hazard' };
  }

  function bandFor(metric, v) {
    return metric === 'pm1' ? pmBand(v) : psiBand(v);
  }

  async function getJson(path) {
    const res = await fetch(API + path, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 429 ? 'Rate limited by data.gov.sg, try again shortly' : 'HTTP ' + res.status);
    const json = await res.json();
    if (json.code !== 0 || !json.data || !json.data.items || !json.data.items.length) {
      throw new Error(json.errorMsg || 'No readings returned');
    }
    return json.data.items[json.data.items.length - 1];
  }

  // Turn the two API items into { updated, regions: { central: {psi24, pm1}, ... } }
  function normalise(psiItem, pmItem) {
    const regions = {};
    for (const r of REGIONS) {
      regions[r] = {
        psi24: numOrNull(psiItem && psiItem.readings && psiItem.readings.psi_twenty_four_hourly, r),
        pm1: numOrNull(pmItem && pmItem.readings && pmItem.readings.pm25_one_hourly, r),
      };
    }
    return {
      psiTimestamp: psiItem ? psiItem.timestamp : null,
      pmTimestamp: pmItem ? pmItem.timestamp : null,
      fetchedAt: Date.now(),
      regions,
    };
  }

  function numOrNull(obj, key) {
    const v = obj ? obj[key] : null;
    return typeof v === 'number' && isFinite(v) ? v : null;
  }

  async function fetchData() {
    const results = await Promise.allSettled([getJson('/psi'), getJson('/pm25')]);
    if (results[0].status === 'rejected' && results[1].status === 'rejected') throw results[0].reason;
    return normalise(
      results[0].status === 'fulfilled' ? results[0].value : null,
      results[1].status === 'fulfilled' ? results[1].value : null
    );
  }

  // Value for a region ('national' = highest of the five regions)
  function valueFor(data, region, metric) {
    if (region === 'national') {
      const vals = REGIONS.map((r) => data.regions[r][metric]).filter((v) => v != null);
      return vals.length ? Math.max.apply(null, vals) : null;
    }
    return data.regions[region] ? data.regions[region][metric] : null;
  }

  function regionLabel(r) {
    return r === 'national' ? 'Singapore (highest region)' : r.charAt(0).toUpperCase() + r.slice(1);
  }

  /* Decide whether to notify. Fires when the reading crosses from below the threshold to at/above it.
     state = { above: boolean }. Returns { notify, state, value }. */
  function evaluate(data, settings, state) {
    const value = valueFor(data, settings.region, settings.metric);
    if (value == null) return { notify: false, state: state || { above: false }, value };
    const above = value >= settings.threshold;
    const wasAbove = !!(state && state.above);
    return { notify: above && !wasAbove, state: { above }, value };
  }

  function alertText(settings, value) {
    const m = METRICS[settings.metric];
    const band = bandFor(settings.metric, value).label;
    return {
      title: 'Haze alert: ' + m.label + ' ' + value + m.unit,
      body: regionLabel(settings.region) + ' is now ' + band + ' and has crossed your threshold of ' + settings.threshold + '.',
    };
  }

  /* ---- tiny IndexedDB key/value store (works in page and service worker) ---- */
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('haze-tracker', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function kvGet(key, fallback) {
    try {
      const db = await idb();
      return await new Promise((resolve, reject) => {
        const r = db.transaction('kv').objectStore('kv').get(key);
        r.onsuccess = () => resolve(r.result === undefined ? fallback : r.result);
        r.onerror = () => reject(r.error);
      });
    } catch (e) {
      return fallback;
    }
  }
  async function kvSet(key, value) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getSettings() {
    return Object.assign({}, DEFAULT_SETTINGS, await kvGet('settings', {}));
  }

  /* Fetch fresh data, store it, and notify if the threshold was crossed.
     `registration` is a ServiceWorkerRegistration. Returns the data. */
  async function runAlertCheck(registration) {
    const data = await fetchData();
    await kvSet('lastData', data);
    const settings = await getSettings();
    if (!settings.enabled) return data;
    const prev = await kvGet('alertState', { above: false });
    const result = evaluate(data, settings, prev);
    await kvSet('alertState', result.state);
    if (result.notify && registration && g.Notification && g.Notification.permission === 'granted') {
      // `registration` may be a promise (page) or a registration (service worker); never wait on it forever.
      const reg = await Promise.race([registration, new Promise((r) => setTimeout(() => r(null), 5000))]);
      if (!reg) return data;
      const text = alertText(settings, result.value);
      await reg.showNotification(text.title, {
        body: text.body,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: 'haze-threshold',
        renotify: true,
      });
    }
    return data;
  }

  const api = {
    REGIONS, METRICS, DEFAULT_SETTINGS,
    psiBand, pmBand, bandFor, normalise, fetchData, valueFor, regionLabel,
    evaluate, alertText, kvGet, kvSet, getSettings, runAlertCheck,
  };
  g.Haze = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
