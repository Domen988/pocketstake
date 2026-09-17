// Pegged — app shell: i18n, tabs, welcome, shared geolocation, online state.

import { fixFromPosition } from './src/proj.js';
import { loadSettings, saveSettings } from './src/store.js';
import { Simulator } from './src/sim.js';
import { showWelcome } from './src/ui/welcome.js';
import { initMap } from './src/ui/map.js';
import { initMeasure } from './src/ui/measure.js';
import { initLog } from './src/ui/log.js';
import { initSettings } from './src/ui/settings.js';

export const APP_VERSION = '0.3.1';

// --- i18n -------------------------------------------------------------------

let strings = {};
let lang = 'en';

export function t(key, vars) {
  let s = strings[lang]?.[key] ?? strings.en?.[key] ?? key;
  if (typeof s === 'string' && vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  }
  return s;
}

function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
}

export function setLang(newLang) {
  lang = newLang;
  document.documentElement.lang = lang;
  applyStaticI18n();
  bus.emit('lang', lang);
}

export function getLang() {
  return lang;
}

// --- tiny event bus ---------------------------------------------------------

export const bus = {
  handlers: {},
  on(ev, fn) {
    (this.handlers[ev] ??= []).push(fn);
  },
  emit(ev, data) {
    for (const fn of this.handlers[ev] ?? []) fn(data);
  },
};

// --- settings ---------------------------------------------------------------

export const settings = loadSettings();

export function persistSettings() {
  saveSettings(settings);
}

// --- shared geolocation -----------------------------------------------------

export const geo = {
  lastFix: null, // Fix in 3794
  watchId: null,
  sim: null,
  started: false,
  start() {
    this.started = true;
    if (settings.simulator.enabled) this._startSim();
    else this._startGps();
  },
  /** Switch source after the simulator toggle changes. */
  restart() {
    if (!this.started) return;
    this._stop();
    this.start();
  },
  simWalk(dE, dN) {
    this.sim?.walk(dE, dN);
  },
  _onFix(fix) {
    if (fix.acc > 25) return; // spec 7.1: discard, no other rule
    this.lastFix = fix;
    bus.emit('fix', fix);
  },
  _startGps() {
    if (this.watchId !== null || !('geolocation' in navigator)) return;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._onFix(fixFromPosition(pos, 'gps')),
      (err) => bus.emit('geo-error', err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
  },
  _startSim() {
    this.sim = new Simulator(settings.simulator);
    this.sim.start((fix) => this._onFix(fix));
  },
  _stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.sim?.stop();
    this.sim = null;
  },
};

// --- tabs -------------------------------------------------------------------

function initTabs() {
  const tabs = document.querySelectorAll('#tabbar .tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((b) => b.classList.toggle('active', b === tab));
      document.querySelectorAll('.screen').forEach((s) => {
        s.classList.toggle('active', s.id === 'screen-' + tab.dataset.screen);
      });
      bus.emit('screen', tab.dataset.screen);
    });
  });
}

export function switchScreen(name) {
  document.querySelector(`#tabbar .tab[data-screen="${name}"]`)?.click();
}

// --- online indicator -------------------------------------------------------

function initNetIndicator() {
  const dot = document.getElementById('net-dot');
  const update = () => {
    dot.classList.toggle('off', !navigator.onLine);
    dot.title = t(navigator.onLine ? 'online' : 'offline');
    bus.emit('net', navigator.onLine);
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

// --- boot -------------------------------------------------------------------

async function boot() {
  const res = await fetch('i18n.json');
  strings = await res.json();
  lang = settings.lang ?? (navigator.language?.toLowerCase().startsWith('sl') ? 'sl' : 'en');
  setLang(lang);

  initTabs();
  initNetIndicator();
  initMap();
  initMeasure();
  initLog();
  initSettings();

  document.getElementById('btn-help').addEventListener('click', () => showWelcome(() => {}));

  // Welcome on every launch; Start is the user gesture that unlocks geolocation.
  showWelcome(() => geo.start());

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
