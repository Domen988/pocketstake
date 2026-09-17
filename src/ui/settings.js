// Settings screen. Phase 1: language, vertex tolerance, offline areas, about.
// Stability threshold / test mode / simulator controls are shown but marked
// with the phase in which they take effect.

import { t, bus, settings, persistSettings, setLang, APP_VERSION } from '../../app.js';
import { listAreas, deleteArea } from '../store.js';
import { deleteOfflineTiles } from '../tiles.js';

export function initSettings() {
  render();
  bus.on('lang', render);
  bus.on('screen', (s) => {
    if (s === 'settings') render();
  });
}

async function render() {
  const root = document.getElementById('settings-root');
  const areas = await listAreas();

  root.innerHTML = `
    <h2>${t('settings.language')}</h2>
    <div class="set-row">
      <span>${t('settings.language')}</span>
      <select id="set-lang">
        <option value="en">${t('settings.lang.en')}</option>
        <option value="sl">${t('settings.lang.sl')}</option>
      </select>
    </div>

    <h2>${t('tab.measure')}</h2>
    <div class="set-row">
      <span>${t('settings.stability')} <span class="muted">(${t('settings.phase3')})</span></span>
      <select id="set-stab">
        <option value="0.3">0.3 m</option>
        <option value="0.5">0.5 m</option>
        <option value="1">1.0 m</option>
      </select>
    </div>
    <div class="set-row">
      <span>${t('settings.vertexTol')}</span>
      <input id="set-tol" type="number" inputmode="numeric" min="0" max="100" step="1" />
    </div>
    <div class="set-row">
      <span>${t('settings.testMode')} <span class="muted">(${t('settings.phase5')})</span></span>
      <input id="set-test" type="checkbox" style="width:26px;height:26px" />
    </div>
    <div class="set-row">
      <span>${t('settings.simulator')} <span class="muted">(${t('settings.phase3')})</span></span>
      <input id="set-sim" type="checkbox" style="width:26px;height:26px" />
    </div>

    <h2>${t('settings.offline')}</h2>
    <div id="areas-list">
      ${
        areas.length
          ? areas
              .map(
                (a) => `
        <div class="set-row" data-area="${a.id}">
          <span>${a.label}<br /><span class="muted">${(a.bytes / 1048576).toFixed(1)} MB · ${new Date(a.at).toLocaleDateString()}</span></span>
          <button class="btn danger" style="flex:none;padding:0 14px">${t('settings.deleteArea')}</button>
        </div>`
              )
              .join('')
          : `<div class="set-row"><span class="muted">${t('settings.noAreas')}</span></div>`
      }
    </div>

    <h2>${t('settings.about')}</h2>
    <p class="about">
      ${t('settings.version')}: ${APP_VERSION}<br />
      ${t('settings.repo')}: <a href="https://github.com/Domen988/pocketstake" target="_blank" rel="noopener">Domen988/pocketstake</a><br /><br />
      ${t('settings.disclaimer')}
    </p>
  `;

  const langSel = root.querySelector('#set-lang');
  langSel.value = settings.lang ?? (navigator.language?.toLowerCase().startsWith('sl') ? 'sl' : 'en');
  langSel.addEventListener('change', () => {
    settings.lang = langSel.value;
    persistSettings();
    setLang(settings.lang);
  });

  const stabSel = root.querySelector('#set-stab');
  stabSel.value = String(settings.stabilityThreshold);
  stabSel.addEventListener('change', () => {
    settings.stabilityThreshold = Number(stabSel.value);
    persistSettings();
  });

  const tolIn = root.querySelector('#set-tol');
  tolIn.value = String(settings.vertexTolCm);
  tolIn.addEventListener('change', () => {
    const v = Math.max(0, Math.min(100, Number(tolIn.value) || 0));
    settings.vertexTolCm = v;
    tolIn.value = String(v);
    persistSettings();
  });

  const testChk = root.querySelector('#set-test');
  testChk.checked = settings.testMode;
  testChk.addEventListener('change', () => {
    settings.testMode = testChk.checked;
    persistSettings();
  });

  const simChk = root.querySelector('#set-sim');
  simChk.checked = settings.simulator.enabled;
  simChk.addEventListener('change', () => {
    settings.simulator.enabled = simChk.checked;
    persistSettings();
  });

  root.querySelectorAll('[data-area] .btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('settings.deleteConfirm'))) return;
      const row = btn.closest('[data-area]');
      const id = row.dataset.area;
      const area = areas.find((a) => a.id === id);
      if (area) await deleteOfflineTiles(area.E, area.N, area.half);
      await deleteArea(id);
      render();
    });
  });
}
