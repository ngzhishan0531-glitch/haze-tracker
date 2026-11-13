(function () {
  'use strict';
  const H = window.Haze;
  const $ = (id) => document.getElementById(id);

  let settings = Object.assign({}, H.DEFAULT_SETTINGS);
  let data = null;
  let lastRefresh = 0;
  let deferredInstall = null;

  const regPromise = 'serviceWorker' in navigator
    ? navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);

  const fmtTime = new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  function when(ts) {
    const d = ts ? new Date(ts) : null;
    return d && !isNaN(d) ? fmtTime.format(d) : 'n/a';
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* ---------- rendering ---------- */
  function readout(label, value, unit, metric) {
    const band = H.bandFor(metric, value);
    return '<div class="readout"><span class="lbl">' + label + '</span>' +
      '<span class="val ' + band.cls + '">' + (value == null ? '–' : value) + '<small>' + (value == null ? '' : unit) + '</small></span>' +
      '<span class="chip ' + band.cls + '">' + band.label + '</span></div>';
  }

  function render() {
    if (!data) return;
    const nat = { psi24: H.valueFor(data, 'national', 'psi24'), pm1: H.valueFor(data, 'national', 'pm1') };
    $('hero').innerHTML =
      '<h2>Singapore <span>highest region</span></h2>' +
      '<div class="pair">' + readout('24-hr PSI', nat.psi24, '', 'psi24') + readout('1-hr PM2.5', nat.pm1, ' µg/m³', 'pm1') + '</div>';

    $('regions').innerHTML = H.REGIONS.map((r) => {
      const v = data.regions[r];
      const watched = settings.enabled && settings.region === r ? ' watched' : '';
      return '<article class="card region' + watched + '"><h3>' + cap(r) + '</h3>' +
        readout('24-hr PSI', v.psi24, '', 'psi24') + readout('1-hr PM2.5', v.pm1, ' µg/m³', 'pm1') + '</article>';
    }).join('');
  }

  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
  }

  function statusLine() {
    if (!data) return;
    setStatus('Readings from ' + when(data.psiTimestamp || data.pmTimestamp) + ' · checked ' + when(data.fetchedAt));
  }

  /* ---------- data ---------- */
  async function refresh() {
    $('refresh').classList.add('spin');
    setStatus('Updating…');
    try {
      data = await H.runAlertCheck(regPromise);
      lastRefresh = Date.now();
      render();
      statusLine();
    } catch (err) {
      const cached = data || (await H.kvGet('lastData', null));
      if (cached) {
        data = cached;
        render();
        setStatus('Could not update (' + err.message + '). Showing readings from ' + when(data.psiTimestamp || data.pmTimestamp) + '.', true);
      } else {
        setStatus('Could not load PSI data: ' + err.message, true);
      }
    } finally {
      $('refresh').classList.remove('spin');
    }
  }

  /* ---------- alerts form ---------- */
  function fillRegionSelect() {
    $('region').innerHTML = ['national'].concat(H.REGIONS)
      .map((r) => '<option value="' + r + '">' + H.regionLabel(r) + '</option>').join('');
  }

  function updateHint() {
    $('threshold-hint').textContent = $('metric').value === 'pm1'
      ? 'NEA 1-hr PM2.5 bands: Normal up to 55, Elevated 56-150, High 151-250, Very high 251+.'
      : 'NEA PSI bands: Good 0-50, Moderate 51-100, Unhealthy 101-200, Very unhealthy 201-300, Hazardous 301+.';
  }

  function formToSettings() {
    return {
      region: $('region').value,
      metric: $('metric').value,
      threshold: Math.max(1, Math.round(Number($('threshold').value) || 0)) || H.DEFAULT_SETTINGS.threshold,
      enabled: $('enabled').checked,
    };
  }

  function settingsToForm() {
    $('region').value = settings.region;
    $('metric').value = settings.metric;
    $('threshold').value = settings.threshold;
    $('enabled').checked = settings.enabled;
    updateHint();
  }

  function note(msg) { $('alert-msg').textContent = msg; }

  async function ensurePermission() {
    if (!('Notification' in window)) {
      note('This browser cannot show notifications. On iPhone, add the app to your Home Screen first (Share, then Add to Home Screen), then open it from there.');
      return false;
    }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') {
      note('Notifications are blocked for this site. Allow them in your browser or phone settings, then try again.');
      return false;
    }
    const result = await Notification.requestPermission();
    if (result !== 'granted') { note('Notification permission was not granted.'); return false; }
    return true;
  }

  async function registerPeriodicSync() {
    try {
      const reg = await regPromise;
      if (reg && 'periodicSync' in reg) {
        await reg.periodicSync.register('haze-check', { minInterval: 60 * 60 * 1000 });
        return true;
      }
    } catch (e) { /* not supported or not permitted */ }
    return false;
  }

  async function onSave(e) {
    e.preventDefault();
    const next = formToSettings();
    note('');
    if (next.enabled && !(await ensurePermission())) next.enabled = false;
    settings = next;
    settingsToForm();
    await H.kvSet('settings', settings);
    await H.kvSet('alertState', { above: false });
    let msg = 'Saved.';
    if (settings.enabled) {
      const bg = await registerPeriodicSync();
      msg = 'Saved. You will be notified when ' + H.regionLabel(settings.region) + ' ' + H.METRICS[settings.metric].label +
        ' reaches ' + settings.threshold + '. ' +
        (bg ? 'Background checks are on.' : 'Checks run while the app is open (background checks need Android Chrome with the app installed).');
    }
    note(msg);
    await refresh();
  }

  async function onTest() {
    note('');
    if (!(await ensurePermission())) return;
    const reg = await regPromise;
    if (!reg) { note('Notifications need the app to be served over HTTPS.'); return; }
    await reg.showNotification('Haze Tracker test', {
      body: 'Notifications are working.', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'haze-test',
    });
    note('Test notification sent.');
  }

  /* ---------- install tip ---------- */
  function setupInstallTip() {
    const tip = $('install-tip');
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone) return;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (ios) {
      tip.hidden = false;
      tip.textContent = 'To install: tap the Share button, then Add to Home Screen.';
    }
    window.addEventListener('beforeinstallprompt', (ev) => {
      ev.preventDefault();
      deferredInstall = ev;
      tip.hidden = false;
      tip.innerHTML = '<button type="button" class="primary" id="install">Add to home screen</button>';
      $('install').addEventListener('click', async () => {
        deferredInstall.prompt();
        await deferredInstall.userChoice;
        deferredInstall = null;
        tip.hidden = true;
      });
    });
    window.addEventListener('appinstalled', () => { tip.hidden = true; });
  }

  /* ---------- start ---------- */
  async function init() {
    fillRegionSelect();
    settings = await H.getSettings();
    settingsToForm();
    const cached = await H.kvGet('lastData', null);
    if (cached) { data = cached; render(); statusLine(); }

    $('alerts').addEventListener('submit', onSave);
    $('test').addEventListener('click', onTest);
    $('refresh').addEventListener('click', refresh);
    $('metric').addEventListener('change', () => {
      $('threshold').value = $('metric').value === 'pm1' ? 56 : 100;
      updateHint();
    });
    setupInstallTip();

    refresh();
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 5 * 60 * 1000) refresh();
    });
  }

  init();
})();
