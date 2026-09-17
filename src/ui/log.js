// Log screen (spec 6.4): measurement list, CSV/JSON export, clear.

import { t, bus } from '../../app.js';
import { loadLog, clearLog } from '../store.js';

const CSV_FIELDS = [
  'id', 'pointEid', 'pointNumber', 'startedAt', 'endedAt', 'nFixes', 'nEffective',
  'meanE', 'meanN', 'sigmaE', 'sigmaN', 'sem', 'stable', 'src', 'calibrationId',
  'correctedE', 'correctedN', 'offsetToTargetE', 'offsetToTargetN', 'distance',
  'bearingTrue', 'revealedError', 'note',
];

export function initLog() {
  bus.on('screen', (s) => {
    if (s === 'log') render();
  });
  bus.on('log-updated', render);
  bus.on('lang', render);
}

function render() {
  const el = document.getElementById('log-root');
  if (!el) return;
  const log = loadLog().slice().reverse();

  el.innerHTML = `
    ${
      log.length
        ? log
            .map(
              (m) => `
      <div class="log-entry">
        <div class="log-head">
          <b>${m.pointNumber ? `${t('measure.target')} ${m.pointNumber}` : t('measure.freeAveraging')}</b>
          <span class="pill ${m.stable ? 'stable' : 'poor'}">${t(m.stable ? 'measure.stable' : 'measure.notStable')}</span>
        </div>
        <div class="log-sub">${new Date(m.endedAt).toLocaleString()} · n ${m.nFixes} · SEM ${m.sem != null ? m.sem.toFixed(2) : '–'} m${m.src === 'sim' ? ' · sim' : ''}</div>
        <div class="log-sub">${
          m.distance != null
            ? `→ ${m.distance.toFixed(1)} m @ ${m.bearingTrue != null ? m.bearingTrue.toFixed(0) + '°' : '–'}`
            : `E ${m.meanE?.toFixed(2)} N ${m.meanN?.toFixed(2)}`
        }${m.calibrationId ? ' · cal' : ''}${m.revealedError != null ? ` · ${t('log.revealed')} ${m.revealedError} m` : ''}</div>
      </div>`
            )
            .join('')
        : `<p class="placeholder">${t('log.empty')}</p>`
    }
    ${
      log.length
        ? `<div class="btn-row" style="padding:0 16px 16px">
            <button class="btn secondary" id="btn-csv">CSV</button>
            <button class="btn secondary" id="btn-json">JSON</button>
            <button class="btn danger" id="btn-clear">${t('log.clear')}</button>
          </div>`
        : ''
    }
  `;

  el.querySelector('#btn-csv')?.addEventListener('click', () => exportLog('csv'));
  el.querySelector('#btn-json')?.addEventListener('click', () => exportLog('json'));
  el.querySelector('#btn-clear')?.addEventListener('click', () => {
    if (!confirm(t('log.clearConfirm'))) return;
    clearLog();
    render();
  });
}

function toCsv(log) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    CSV_FIELDS.join(','),
    ...log.map((m) => CSV_FIELDS.map((f) => esc(m[f])).join(',')),
  ].join('\n');
}

async function exportLog(kind) {
  const log = loadLog();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = `pegged-log-${stamp}.${kind}`;
  const content = kind === 'csv' ? toCsv(log) : JSON.stringify(log, null, 2);
  const type = kind === 'csv' ? 'text/csv' : 'application/json';
  const file = new File([content], name, { type });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch {
      /* cancelled or unsupported -> fall through to download */
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
