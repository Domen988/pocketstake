// Measure screen (spec 6.3): Approach (radar, distance, compass arrow) and
// Averaging (fix cloud, shrinking uncertainty rings, stability) on one screen.

import { t, bus, geo, settings } from '../../app.js';
import { Averager, buildMeasurement, trueBearingDeg, windName } from '../measure.js';
import { compass, wedgeDeg } from '../compass.js';
import { d96ToWgs } from '../proj.js';
import { appendLog, loadLog } from '../store.js';

const COLOURS = { green: '#38c172', yellow: '#f2c744', red: '#e5533d' };

const st = {
  target: null, // Point or null (free averaging is allowed)
  parcelPoints: [],
  mode: 'approach', // 'approach' | 'averaging' | 'result'
  avg: null,
  result: null,
  tick: null,
  wakeLock: null,
  vibrated: false,
  active: false,
};

export function initMeasure() {
  bus.on('target', ({ point, points }) => {
    st.target = point;
    st.parcelPoints = points ?? [];
    if (st.mode !== 'averaging') st.mode = 'approach';
    render();
  });
  bus.on('screen', (s) => {
    st.active = s === 'measure';
    if (st.active) {
      if (!compass.needsPermission) compass.start();
      render();
    }
  });
  bus.on('fix', (fix) => {
    if (st.mode === 'averaging' && st.avg) st.avg.addFix(fix);
    else if (st.active && st.mode === 'approach') render();
  });
  compass.onChange(() => {
    if (st.active && st.mode === 'approach') render();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && st.mode === 'averaging') acquireWakeLock();
  });
}

function root() {
  return document.getElementById('measure-root');
}

// --- rendering dispatch -----------------------------------------------------

function render() {
  if (!st.active) return;
  if (st.mode === 'approach') renderApproach();
  else if (st.mode === 'averaging') renderAveraging();
  else renderResult();
}

// --- approach ---------------------------------------------------------------

function renderApproach() {
  const fix = geo.lastFix;
  const tg = st.target;
  let distTxt = '–';
  let bearing = null;
  if (fix && tg) {
    const dE = tg.E - fix.E;
    const dN = tg.N - fix.N;
    const [lon, lat] = d96ToWgs([fix.E, fix.N]);
    bearing = trueBearingDeg(fix.E, fix.N, tg.E, tg.N, lon, lat);
    const d = Math.hypot(dE, dN);
    distTxt = d < 1000 ? `${d.toFixed(1)} m` : `${(d / 1000).toFixed(2)} km`;
  }

  root().innerHTML = `
    <div class="m-target">${
      tg
        ? `<span class="badge ${tg.colour}"></span> ${t('measure.target')} ${tg.number}`
        : `<span class="muted">${t('measure.noTarget')}</span>`
    }</div>
    <canvas id="radar" class="radar"></canvas>
    <div class="m-big">${distTxt}</div>
    <div class="m-arrow-row">
      <div id="arrow-box"></div>
      <div class="m-compass-note" id="compass-note"></div>
    </div>
    <button class="btn" id="btn-start-avg">${t('measure.start')}</button>
  `;

  drawRadar({ radiusM: 20, fix, showFixCloud: false });
  drawArrowBox(bearing);
  updateCompassNote(bearing);

  document.getElementById('btn-start-avg').addEventListener('click', startAveraging);

  if (compass.needsPermission && !compass.started) {
    const note = document.getElementById('compass-note');
    const b = document.createElement('button');
    b.className = 'btn secondary btn-small';
    b.textContent = t('measure.enableCompass');
    b.addEventListener('click', async () => {
      await compass.start();
      render();
    });
    note.appendChild(b);
  }
}

function updateCompassNote(bearing) {
  const el = document.getElementById('compass-note');
  if (!el) return;
  if (compass.headingTrue !== null) {
    const w = wedgeDeg();
    el.textContent = `${t('measure.compass')} ±${w.toFixed(0)}°`;
    if (w > 25) el.textContent += ` — ${t('measure.calibrateCompass')}`;
  } else if (bearing !== null) {
    el.textContent = `${t('measure.noHeading')} — ${bearing.toFixed(0)}° ${windName(bearing)}`;
  } else {
    el.textContent = geo.lastFix ? '' : t('map.noFix');
  }
}

/** Arrow + accuracy wedge. Rotates with the device heading when available. */
function drawArrowBox(bearingTrue) {
  const box = document.getElementById('arrow-box');
  if (!box) return;
  if (bearingTrue === null) {
    box.innerHTML = '';
    return;
  }
  const heading = compass.headingTrue;
  const rot = heading === null ? bearingTrue : bearingTrue - heading;
  const w = wedgeDeg();
  const a1 = ((rot - w) * Math.PI) / 180;
  const a2 = ((rot + w) * Math.PI) / 180;
  const cx = 60, cy = 60, r = 54;
  const x1 = cx + r * Math.sin(a1), y1 = cy - r * Math.cos(a1);
  const x2 = cx + r * Math.sin(a2), y2 = cy - r * Math.cos(a2);
  const large = w > 90 ? 1 : 0;
  box.innerHTML = `
    <svg width="120" height="120" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="56" fill="none" stroke="#2a3644" stroke-width="1.5"/>
      <path d="M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z"
            fill="rgba(77,163,255,0.18)"/>
      <g transform="rotate(${rot.toFixed(1)} 60 60)">
        <path d="M 60 14 L 72 52 L 60 44 L 48 52 Z" fill="#4da3ff"/>
        <line x1="60" y1="44" x2="60" y2="98" stroke="#4da3ff" stroke-width="5" stroke-linecap="round"/>
      </g>
    </svg>`;
}

// --- averaging --------------------------------------------------------------

function startAveraging() {
  st.avg = new Averager({ threshold: settings.stabilityThreshold });
  st.mode = 'averaging';
  st.vibrated = false;
  if (geo.lastFix) st.avg.addFix(geo.lastFix);
  acquireWakeLock();
  clearInterval(st.tick);
  st.tick = setInterval(updateAveraging, 500);
  renderAveraging();
}

async function acquireWakeLock() {
  try {
    st.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    st.wakeLock = null;
    toastHint();
  }
}

let hintShown = false;
function toastHint() {
  if (hintShown) return;
  hintShown = true;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = t('wakeLock.hint');
  document.getElementById('screen-measure').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function releaseWakeLock() {
  st.wakeLock?.release().catch(() => {});
  st.wakeLock = null;
}

function renderAveraging() {
  const tg = st.target;
  root().innerHTML = `
    <div class="m-target">${
      tg
        ? `<span class="badge ${tg.colour}"></span> ${t('measure.target')} ${tg.number}`
        : `<span class="muted">${t('measure.freeAveraging')}</span>`
    }
      <span id="status-pill" class="pill collecting">${t('measure.collecting')}</span>
    </div>
    <canvas id="radar" class="radar"></canvas>
    <div class="m-grid" id="m-grid"></div>
    <canvas id="sparkline" class="sparkline"></canvas>
    <button class="btn danger" id="btn-stop-avg">${t('measure.stop')}</button>
  `;
  document.getElementById('btn-stop-avg').addEventListener('click', stopAveraging);
  updateAveraging();
}

function updateAveraging() {
  if (!st.avg) return;
  const s = st.avg.snapshot(Date.now());

  if (st.active && st.mode === 'averaging') {
    const grid = document.getElementById('m-grid');
    if (grid) {
      const f = (v, d = 2) => (v == null ? '–' : v.toFixed(d));
      grid.innerHTML = `
        <div><span>${t('measure.elapsed')}</span><b>${Math.floor(s.elapsed / 60)}:${String(Math.floor(s.elapsed % 60)).padStart(2, '0')}</b></div>
        <div><span>${t('measure.fixes')}</span><b>${s.nAccepted}/${s.nFixes}</b></div>
        <div><span>n<sub>eff</sub></span><b>${s.nEffective}</b></div>
        <div><span>σ</span><b>${f(s.sigmaE != null ? Math.hypot(s.sigmaE, s.sigmaN) : null)} m</b></div>
        <div><span>SEM</span><b>${f(s.sem)} m</b></div>
        <div><span>${t('measure.drift')}</span><b>${f(s.drift60)} m</b></div>
        <div><span>${t('acc.label')}</span><b>±${f(s.lastAcc, 0)} m</b></div>
      `;
    }
    const pill = document.getElementById('status-pill');
    if (pill) {
      if (s.poorSky) {
        pill.className = 'pill poor';
        pill.textContent = `${t('measure.poorSky')} — ${t('measure.moveOpenSky')}`;
      } else if (s.stable) {
        pill.className = 'pill stable';
        pill.textContent = t('measure.stable');
      } else {
        pill.className = 'pill collecting';
        pill.textContent = t('measure.collecting');
      }
    }
    drawRadar({ radiusM: 5, showFixCloud: true, snap: s });
    drawSparkline(s);
  }

  if (s.stable && !st.vibrated) {
    st.vibrated = true;
    navigator.vibrate?.([180, 90, 180]);
  }
}

function stopAveraging() {
  clearInterval(st.tick);
  releaseWakeLock();
  const now = Date.now();
  st.result = buildMeasurement(st.avg, {
    id: crypto.randomUUID(),
    point: st.target,
    now,
  });
  st.mode = 'result';
  renderResult();
}

// --- result -----------------------------------------------------------------

function renderResult() {
  const m = st.result;
  const tg = st.target;
  let headline = t('measure.noOffset');
  let compTxt = '';
  let bearing = null;
  if (m.distance !== null) {
    const [lon, lat] = d96ToWgs([m.correctedE, m.correctedN]);
    bearing = trueBearingDeg(m.correctedE, m.correctedN, tg.E, tg.N, lon, lat);
    m.bearingTrue = bearing;
    headline = t('measure.resultAt', {
      d: m.distance.toFixed(1),
      b: bearing.toFixed(0),
      w: windName(bearing),
    });
    const ns = m.offsetToTargetN >= 0 ? t('dir.N') : t('dir.S');
    const ew = m.offsetToTargetE >= 0 ? t('dir.E') : t('dir.W');
    compTxt = `${Math.abs(m.offsetToTargetN).toFixed(1)} m ${ns}, ${Math.abs(m.offsetToTargetE).toFixed(1)} m ${ew}`;
  }

  root().innerHTML = `
    <div class="m-target">${
      tg ? `<span class="badge ${tg.colour}"></span> ${t('measure.target')} ${tg.number}` : ''
    }
      <span class="pill ${m.stable ? 'stable' : 'poor'}">${t(m.stable ? 'measure.stable' : 'measure.notStable')}</span>
    </div>
    <div class="result-card">
      <div class="m-big">${headline}</div>
      ${compTxt ? `<div class="m-comp">${compTxt}</div>` : ''}
      ${bearing !== null ? `<div class="m-arrow-row"><div id="arrow-box"></div><div class="m-compass-note" id="compass-note"></div></div>` : ''}
      <div class="row"><span class="k">σ / SEM</span>
        <span>${m.sigmaE != null ? Math.hypot(m.sigmaE, m.sigmaN).toFixed(2) : '–'} / ${m.sem != null ? m.sem.toFixed(2) : '–'} m</span></div>
      <div class="row"><span class="k">n</span><span>${m.nFixes} (${m.nEffective} ${t('measure.effShort')})</span></div>
      <div class="warn">${t('measure.uncorrected')}</div>
      <div class="btn-row">
        <button class="btn" id="btn-save">${t('measure.save')}</button>
        <button class="btn secondary" id="btn-again">${t('measure.again')}</button>
      </div>
    </div>
  `;
  if (bearing !== null) {
    drawArrowBox(bearing);
    updateCompassNote(bearing);
  }
  document.getElementById('btn-save').addEventListener('click', () => {
    appendLog(st.result);
    bus.emit('log-updated');
    st.mode = 'approach';
    render();
  });
  document.getElementById('btn-again').addEventListener('click', () => {
    st.mode = 'approach';
    render();
  });
}

// --- radar ------------------------------------------------------------------

function drawRadar({ radiusM, fix = null, showFixCloud = false, snap = null }) {
  const canvas = document.getElementById('radar');
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssSize = canvas.clientWidth || 300;
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  const ctx = canvas.getContext('2d');
  const c = canvas.width / 2;
  const pxPerM = (canvas.width / 2 - 8 * dpr) / radiusM;

  // centre: live fix on approach, running mean (fallback: live fix) while averaging
  let cE, cN;
  if (showFixCloud && snap?.meanE != null) {
    cE = snap.meanE;
    cN = snap.meanN;
  } else if (fix ?? geo.lastFix) {
    cE = (fix ?? geo.lastFix).E;
    cN = (fix ?? geo.lastFix).N;
  } else if (st.target) {
    cE = st.target.E;
    cN = st.target.N;
  } else {
    cE = 0;
    cN = 0;
  }
  const toXY = (E, N) => [c + (E - cE) * pxPerM, c - (N - cN) * pxPerM];

  // rings
  ctx.strokeStyle = '#233040';
  ctx.lineWidth = 1 * dpr;
  const step = radiusM <= 5 ? 1 : 5;
  for (let r = step; r <= radiusM; r += step) {
    ctx.beginPath();
    ctx.arc(c, c, r * pxPerM, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#54677a';
  ctx.font = `${11 * dpr}px system-ui`;
  ctx.textAlign = 'center';
  ctx.fillText('N', c, c - radiusM * pxPerM + 14 * dpr);
  ctx.fillText(`${radiusM} m`, c + radiusM * pxPerM - 16 * dpr, c + 4 * dpr);

  // other parcel points, faint
  for (const p of st.parcelPoints) {
    if (st.target && String(p.eid) === String(st.target.eid)) continue;
    const [x, y] = toXY(p.E, p.N);
    if (Math.hypot(x - c, y - c) > radiusM * pxPerM) continue;
    ctx.beginPath();
    ctx.arc(x, y, 3.5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = COLOURS[p.colour] + '55';
    ctx.fill();
  }

  // previous saved measurements near here, small dots
  for (const m of loadLog()) {
    if (m.meanE == null) continue;
    const [x, y] = toXY(m.meanE, m.meanN);
    if (Math.hypot(x - c, y - c) > radiusM * pxPerM) continue;
    ctx.beginPath();
    ctx.arc(x, y, 2.5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#8aa0b4';
    ctx.fill();
  }

  // averaging cloud: every accepted fix faint, rejected fixes crossed out
  if (showFixCloud && st.avg) {
    for (const f of st.avg.fixes) {
      const [x, y] = toXY(f.E, f.N);
      if (Math.hypot(x - c, y - c) > radiusM * pxPerM) continue;
      ctx.beginPath();
      ctx.arc(x, y, 2 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = f.accepted ? 'rgba(77,163,255,0.35)' : 'rgba(229,83,61,0.4)';
      ctx.fill();
    }
    if (snap?.meanE != null) {
      const [mx, my] = toXY(snap.meanE, snap.meanN);
      // 2σ spread ring (the cloud), faint dashes
      const sigma = Math.hypot(snap.sigmaE, snap.sigmaN);
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(2 * sigma * pxPerM, 3 * dpr), 0, Math.PI * 2);
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = 'rgba(138,160,180,0.6)';
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
      ctx.setLineDash([]);
      // 2·SEM ring: the uncertainty of the AVERAGE — this one shrinks
      if (snap.sem != null) {
        ctx.beginPath();
        ctx.arc(mx, my, Math.max(2 * snap.sem * pxPerM, 3 * dpr), 0, Math.PI * 2);
        ctx.strokeStyle = snap.stable ? '#38c172' : '#4da3ff';
        ctx.lineWidth = 2 * dpr;
        ctx.stroke();
      }
      // running mean dot
      ctx.beginPath();
      ctx.arc(mx, my, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = snap.stable ? '#38c172' : '#4da3ff';
      ctx.fill();
    }
  }

  // live position (approach: centre dot)
  if (!showFixCloud) {
    ctx.beginPath();
    ctx.arc(c, c, 6 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#4da3ff';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
  }

  // target
  if (st.target) {
    const [x, y] = toXY(st.target.E, st.target.N);
    const inR = Math.hypot(x - c, y - c) <= radiusM * pxPerM;
    if (inR) {
      ctx.beginPath();
      ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = COLOURS[st.target.colour];
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    } else {
      // edge marker toward the target
      const ang = Math.atan2(x - c, -(y - c));
      const ex = c + (radiusM * pxPerM - 6 * dpr) * Math.sin(ang);
      const ey = c - (radiusM * pxPerM - 6 * dpr) * Math.cos(ang);
      ctx.beginPath();
      ctx.arc(ex, ey, 5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = COLOURS[st.target.colour];
      ctx.fill();
    }
  }
}

// --- sparkline: running-mean displacement from the current mean -------------

function drawSparkline(snap) {
  const canvas = document.getElementById('sparkline');
  if (!canvas || !st.avg || snap.meanE == null) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = (canvas.clientWidth || 300) * dpr;
  const h = 40 * dpr;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const hist = st.avg.meanHistory;
  if (hist.length < 2) return;
  const d = hist.map((s) => Math.hypot(s.E - snap.meanE, s.N - snap.meanN));
  const max = Math.max(...d, 0.5);
  ctx.beginPath();
  hist.forEach((s, i) => {
    const x = (i / (hist.length - 1)) * (w - 4 * dpr) + 2 * dpr;
    const y = h - 3 * dpr - (d[i] / max) * (h - 8 * dpr);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 1.5 * dpr;
  ctx.stroke();
  ctx.fillStyle = '#54677a';
  ctx.font = `${10 * dpr}px system-ui`;
  ctx.textAlign = 'right';
  ctx.fillText(`${max.toFixed(1)} m`, w - 4 * dpr, 10 * dpr);
}
