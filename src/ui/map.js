// Map screen: canvas with WMS tiles, parcel/point overlays, live position,
// pan/pinch, parcel tap + search, offline preparation.

import { t, bus, geo, settings, persistSettings } from '../../app.js';
import { TileCache, tilesInBbox, TILE_M, prepareOfflineTiles, deleteOfflineTiles } from '../tiles.js';
import {
  fetchParcelAtPoint,
  fetchParcelByNumber,
  fetchPointsAndSegments,
  ringBbox,
} from '../gurs.js';
import {
  saveParcelData,
  listStoredParcels,
  loadParcelData,
  loadFoundFlags,
  setFoundFlag,
  saveArea,
} from '../store.js';
import { dist } from '../proj.js';

const COLOURS = { green: '#38c172', yellow: '#f2c744', red: '#e5533d' };

const state = {
  canvas: null,
  ctx: null,
  view: { E: 486450, N: 46480, scale: 2 }, // px per metre; default centre = fixture area
  follow: true, // recentre on fixes until the user pans
  hadFirstFix: false,
  parcel: null,
  points: [],
  segments: [],
  tiles: new TileCache(),
  dirty: true,
};

export function initMap() {
  state.canvas = document.getElementById('map-canvas');
  state.ctx = state.canvas.getContext('2d');

  new ResizeObserver(resize).observe(state.canvas);
  resize();

  initPointerHandling();

  document.getElementById('btn-recentre').addEventListener('click', () => {
    if (geo.lastFix) {
      state.view.E = geo.lastFix.E;
      state.view.N = geo.lastFix.N;
    }
    state.follow = true;
    invalidate();
  });

  document.getElementById('btn-search').addEventListener('click', showSearchPanel);

  bus.on('fix', (fix) => {
    if (!state.hadFirstFix || state.follow) {
      state.view.E = fix.E;
      state.view.N = fix.N;
    }
    state.hadFirstFix = true;
    updateAccChip(fix);
    invalidate();
  });
  bus.on('geo-error', () => {
    const chip = document.getElementById('acc-readout');
    chip.textContent = t('map.noFix');
    chip.className = 'overlay-chip acc-red';
  });
  bus.on('net', (online) => {
    if (online) {
      state.tiles.clearMissing();
      invalidate();
    }
  });
  bus.on('lang', invalidate);

  requestAnimationFrame(frame);
}

function invalidate() {
  state.dirty = true;
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = state.canvas.getBoundingClientRect();
  state.canvas.width = Math.round(r.width * dpr);
  state.canvas.height = Math.round(r.height * dpr);
  state.dpr = dpr;
  invalidate();
}

// --- coordinate mapping -----------------------------------------------------

function toScreen(E, N) {
  const { view, canvas, dpr } = state;
  return [
    canvas.width / 2 + (E - view.E) * view.scale * dpr,
    canvas.height / 2 - (N - view.N) * view.scale * dpr,
  ];
}

function toWorld(x, y) {
  // x, y in CSS pixels relative to the canvas
  const { view, canvas, dpr } = state;
  return [
    view.E + (x * dpr - canvas.width / 2) / (view.scale * dpr),
    view.N - (y * dpr - canvas.height / 2) / (view.scale * dpr),
  ];
}

// --- input ------------------------------------------------------------------

function initPointerHandling() {
  const c = state.canvas;
  const pointers = new Map();
  let tapStart = null;
  let pinchStart = null;

  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      tapStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    } else if (pointers.size === 2) {
      tapStart = null;
      const [a, b] = [...pointers.values()];
      pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: state.view.scale };
    }
  });

  c.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);

    if (pointers.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (dx || dy) {
        state.view.E -= dx / state.view.scale;
        state.view.N += dy / state.view.scale;
        state.follow = false;
        invalidate();
      }
    } else if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      state.view.scale = Math.min(16, Math.max(0.25, (pinchStart.scale * d) / pinchStart.d));
      state.follow = false;
      invalidate();
    }
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (tapStart && pointers.size === 0) {
      const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
      if (moved < 12 && Date.now() - tapStart.t < 500) handleTap(e);
      tapStart = null;
    }
  };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    pinchStart = null;
    tapStart = null;
  });
}

async function handleTap(e) {
  const r = state.canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;

  // points first (generous 26 px hit radius)
  let best = null;
  for (const p of state.points) {
    const [px, py] = toScreen(p.E, p.N);
    const d = Math.hypot(px / state.dpr - x, py / state.dpr - y);
    if (d < 26 && (!best || d < best.d)) best = { p, d };
  }
  if (best) {
    showPointCard(best.p);
    return;
  }

  const [E, N] = toWorld(x, y);
  await openParcelAt(E, N);
}

// --- parcel loading ---------------------------------------------------------

async function openParcelAt(E, N) {
  hideCard();
  if (!navigator.onLine) {
    const stored = await findStoredParcelAt(E, N);
    if (stored) applyParcelData(stored);
    else toast(t('map.offlineNoFetch'));
    return;
  }
  toast(t('map.searching'));
  try {
    const parcel = await fetchParcelAtPoint(E, N);
    if (!parcel) {
      toast(t('map.notFound'));
      return;
    }
    await loadParcelDetails(parcel);
  } catch {
    toast(t('map.loadFailed'));
  }
}

async function loadParcelDetails(parcel) {
  const tolM = (settings.vertexTolCm ?? 1) / 100;
  const { points, segments } = await fetchPointsAndSegments(parcel, tolM);
  const found = loadFoundFlags();
  for (const p of points) p.foundPhysically = !!found[String(p.eid)];
  state.parcel = parcel;
  state.points = points;
  state.segments = segments;
  await saveParcelData(parcel, points, segments);
  hideToast();
  invalidate();
  showParcelCard();
}

async function findStoredParcelAt(E, N) {
  for (const parcel of await listStoredParcels()) {
    if (pointInRing(E, N, parcel.ring)) return loadParcelData(parcel.eid);
  }
  return null;
}

function applyParcelData({ parcel, points, segments }) {
  const found = loadFoundFlags();
  for (const p of points) p.foundPhysically = !!found[String(p.eid)];
  state.parcel = parcel;
  state.points = points;
  state.segments = segments;
  invalidate();
  showParcelCard();
}

function pointInRing(E, N, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > N !== yj > N && E < ((xj - xi) * (N - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// --- cards ------------------------------------------------------------------

function card() {
  return document.getElementById('card');
}

function hideCard() {
  card().classList.add('hidden');
  document.getElementById('search-panel').classList.add('hidden');
}

function showParcelCard() {
  const p = state.parcel;
  const own = state.points.filter((x) => x.onParcel);
  const counts = { green: 0, yellow: 0, red: 0 };
  for (const x of own) counts[x.colour]++;
  const el = card();
  el.innerHTML = `
    <h2>${p.koName} ${p.number}<button class="close-x">✕</button></h2>
    <div class="row"><span class="k">KO</span><span>${p.koId} ${p.koName}</span></div>
    <div class="row"><span class="k">${t('parcel.area')}</span><span>${p.area} m²</span></div>
    <div class="row"><span class="k">${t('parcel.status')}</span><span>${p.status ?? '–'}</span></div>
    <div class="row"><span class="k">${t('parcel.points')}</span>
      <span><span class="badge green"></span> ${counts.green}&nbsp;&nbsp;<span class="badge yellow"></span> ${counts.yellow}&nbsp;&nbsp;<span class="badge red"></span> ${counts.red}</span>
    </div>
    <div class="btn-row"><button class="btn" id="btn-prepare">${t('parcel.prepare')}</button></div>
    <div id="prepare-status" class="warn"></div>
  `;
  el.classList.remove('hidden');
  el.querySelector('.close-x').addEventListener('click', hideCard);
  el.querySelector('#btn-prepare').addEventListener('click', prepareOffline);
}

async function prepareOffline() {
  const p = state.parcel;
  const status = document.getElementById('prepare-status');
  const btn = document.getElementById('btn-prepare');
  btn.disabled = true;
  const [e0, n0, e1, n1] = ringBbox(p.ring, 0);
  const cE = (e0 + e1) / 2;
  const cN = (n0 + n1) / 2;
  try {
    const bytes = await prepareOfflineTiles(cE, cN, 250, (done, total) => {
      status.textContent = t('parcel.preparing', { done, total });
    });
    await saveParcelData(p, state.points, state.segments);
    await saveArea({
      id: String(p.eid),
      label: `${p.koName} ${p.number}`,
      E: cE,
      N: cN,
      half: 250,
      bytes,
      at: Date.now(),
    });
    status.textContent = t('parcel.prepared', { mb: (bytes / 1048576).toFixed(1) });
  } catch {
    status.textContent = t('parcel.prepareFailed');
  }
  btn.disabled = false;
}

function showPointCard(p) {
  const el = card();
  const fix = geo.lastFix;
  const d = fix ? dist(fix.E, fix.N, p.E, p.N) : null;
  const red = p.colour === 'red';
  el.innerHTML = `
    <h2><span class="badge ${p.colour}"></span> ${t('point.title')} ${p.number}
      <button class="close-x">✕</button></h2>
    <div class="row"><span class="k">${t('point.accuracy')}</span><span>${t('point.acc.' + p.accCode)}</span></div>
    <div class="row"><span class="k">${t('point.method')}</span><span>${p.methodName || p.methodCode}</span></div>
    <div class="row"><span class="k">${t('point.status')}</span><span>${p.statusName || p.statusCode}</span></div>
    ${p.marking ? `<div class="row"><span class="k">${t('point.marking')}</span><span>${p.marking}</span></div>` : ''}
    <div class="row"><span class="k">${t('point.distance')}</span>
      <span class="big">${d === null ? '–' : d < 1000 ? d.toFixed(1) + ' m' : (d / 1000).toFixed(1) + ' km'}</span></div>
    ${p.onParcel ? '' : `<div class="warn">${t('point.neighbour')}</div>`}
    ${red ? `<div class="warn">${t('point.redWarn')}</div>` : ''}
    ${p.foundPhysically ? `<div class="warn" style="color:var(--green)">${t('point.foundYes')}</div>` : ''}
    <div class="btn-row">
      <button class="btn ${red ? 'secondary' : ''}" id="btn-goto">${t('point.goto')}</button>
      <button class="btn secondary" id="btn-found">${t(p.foundPhysically ? 'point.unmarkFound' : 'point.markFound')}</button>
    </div>
  `;
  el.classList.remove('hidden');
  el.querySelector('.close-x').addEventListener('click', hideCard);
  el.querySelector('#btn-goto').addEventListener('click', () => {
    if (red && !confirm(t('point.gotoRedConfirm'))) return;
    bus.emit('target', p);
    toast(t('measure.soon'));
  });
  el.querySelector('#btn-found').addEventListener('click', () => {
    p.foundPhysically = !p.foundPhysically;
    setFoundFlag(p.eid, p.foundPhysically);
    if (state.parcel) saveParcelData(state.parcel, state.points, state.segments);
    showPointCard(p);
    invalidate();
  });
}

// --- search -----------------------------------------------------------------

function showSearchPanel() {
  hideCard();
  const el = document.getElementById('search-panel');
  el.innerHTML = `
    <h2>${t('map.searchTitle')}<button class="close-x">✕</button></h2>
    <div class="field"><label>${t('map.koId')}</label>
      <input id="in-ko" type="number" inputmode="numeric" placeholder="1590"></div>
    <div class="field"><label>${t('map.parcelNo')}</label>
      <input id="in-st" type="text" placeholder="3319"></div>
    <div class="btn-row"><button class="btn" id="btn-do-search">${t('map.load')}</button></div>
    <div id="search-status" class="error"></div>
  `;
  el.classList.remove('hidden');
  el.querySelector('.close-x').addEventListener('click', () => el.classList.add('hidden'));
  el.querySelector('#btn-do-search').addEventListener('click', async () => {
    const ko = el.querySelector('#in-ko').value.trim();
    const st = el.querySelector('#in-st').value.trim();
    const status = el.querySelector('#search-status');
    if (!ko || !st) return;
    status.textContent = t('map.searching');
    try {
      let data = null;
      if (navigator.onLine) {
        const parcel = await fetchParcelByNumber(ko, st);
        if (parcel) {
          el.classList.add('hidden');
          await loadParcelDetails(parcel);
          centreOnParcel(parcel);
          return;
        }
      } else {
        const stored = (await listStoredParcels()).find(
          (p) => p.koId === Number(ko) && p.number === st
        );
        if (stored) data = await loadParcelData(stored.eid);
        if (data) {
          el.classList.add('hidden');
          applyParcelData(data);
          centreOnParcel(data.parcel);
          return;
        }
      }
      status.textContent = t(navigator.onLine ? 'map.notFound' : 'map.offlineNoFetch');
    } catch {
      status.textContent = t('map.loadFailed');
    }
  });
}

function centreOnParcel(parcel) {
  const [e0, n0, e1, n1] = ringBbox(parcel.ring, 10);
  state.view.E = (e0 + e1) / 2;
  state.view.N = (n0 + n1) / 2;
  const r = state.canvas.getBoundingClientRect();
  state.view.scale = Math.min(
    16,
    Math.max(0.25, Math.min(r.width / (e1 - e0), r.height / (n1 - n0)))
  );
  state.follow = false;
  invalidate();
}

// --- toast ------------------------------------------------------------------

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 3500);
}
function hideToast() {
  document.getElementById('toast').classList.add('hidden');
}

// --- accuracy chip ----------------------------------------------------------

function updateAccChip(fix) {
  const chip = document.getElementById('acc-readout');
  chip.textContent = `${t('acc.label')} ±${fix.acc.toFixed(0)} m`;
  chip.className =
    'overlay-chip ' + (fix.acc < 4 ? 'acc-green' : fix.acc <= 8 ? 'acc-yellow' : 'acc-red');
}

// --- rendering --------------------------------------------------------------

function frame() {
  if (state.dirty) {
    state.dirty = false;
    render();
  }
  requestAnimationFrame(frame);
}

function render() {
  const { ctx, canvas, view, dpr } = state;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const halfWm = canvas.width / 2 / (view.scale * dpr);
  const halfHm = canvas.height / 2 / (view.scale * dpr);
  const bbox = [view.E - halfWm, view.N - halfHm, view.E + halfWm, view.N + halfHm];

  const px = TILE_M * view.scale * dpr;
  for (const [E0, N0] of tilesInBbox(bbox)) {
    const [x, y] = toScreen(E0, N0 + TILE_M);
    const dof = state.tiles.getNow('dof', E0, N0, invalidate);
    if (dof) ctx.drawImage(dof, x, y, px, px);
    else drawNoData(ctx, x, y, px);
    const kn = state.tiles.getNow('kn', E0, N0, invalidate);
    if (kn) ctx.drawImage(kn, x, y, px, px);
  }

  if (state.parcel) drawParcel(ctx);
  drawPosition(ctx);
  updateScaleBar();
}

function drawNoData(ctx, x, y, px) {
  ctx.fillStyle = '#151b22';
  ctx.fillRect(x, y, px, px);
  ctx.strokeStyle = '#232d38';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, px, px);
  if (!navigator.onLine && px > 140) {
    ctx.fillStyle = '#54677a';
    ctx.font = `${13 * state.dpr}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText(t('map.noMapData'), x + px / 2, y + px / 2);
  }
}

function drawParcel(ctx) {
  const { dpr } = state;
  // parcel outline
  ctx.beginPath();
  state.parcel.ring.forEach(([E, N], i) => {
    const [x, y] = toScreen(E, N);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 2.5 * dpr;
  ctx.stroke();
  ctx.fillStyle = 'rgba(77,163,255,0.08)';
  ctx.fill();

  // urejene segments thicker
  const byEid = new Map(state.points.map((p) => [String(p.eid), p]));
  for (const s of state.segments) {
    if (!s.urejena) continue;
    const a = byEid.get(s.fromEid);
    const b = byEid.get(s.toEid);
    if (!a || !b) continue;
    const [x1, y1] = toScreen(a.E, a.N);
    const [x2, y2] = toScreen(b.E, b.N);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = '#8fd0ff';
    ctx.lineWidth = 5 * dpr;
    ctx.stroke();
  }

  // points
  for (const p of state.points) {
    const [x, y] = toScreen(p.E, p.N);
    const r = (p.onParcel ? 7 : 4.5) * dpr;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = COLOURS[p.colour];
    ctx.fill();
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = '#0b0f14';
    ctx.stroke();
    if (p.foundPhysically) {
      ctx.beginPath();
      ctx.arc(x, y, r + 3 * dpr, 0, Math.PI * 2);
      ctx.strokeStyle = '#e8eef4';
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
    }
    if (p.onParcel && state.view.scale >= 2) {
      ctx.fillStyle = '#e8eef4';
      ctx.font = `${11 * dpr}px system-ui`;
      ctx.textAlign = 'left';
      ctx.fillText(p.number, x + r + 3 * dpr, y - r);
    }
  }
}

function drawPosition(ctx) {
  const fix = geo.lastFix;
  if (!fix) return;
  const { dpr, view } = state;
  const [x, y] = toScreen(fix.E, fix.N);
  const rAcc = fix.acc * view.scale * dpr;
  ctx.beginPath();
  ctx.arc(x, y, rAcc, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(77,163,255,0.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(77,163,255,0.5)';
  ctx.lineWidth = 1 * dpr;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 6 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = '#4da3ff';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();
}

function updateScaleBar() {
  const targetPx = 90;
  const m = targetPx / state.view.scale;
  const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((n) => n >= m) ?? 500;
  document.getElementById('scale-line').style.width = `${nice * state.view.scale}px`;
  document.getElementById('scale-text').textContent = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
}
