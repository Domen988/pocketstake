// Settings screen. Phase 1: language, vertex tolerance, offline areas, about.
// Stability threshold / test mode / simulator controls are shown but marked
// with the phase in which they take effect.

import { t, bus, settings, persistSettings, setLang, APP_VERSION, geo } from '../../app.js';
import { listAreas, deleteArea } from '../store.js';
import { deleteOfflineTiles } from '../tiles.js';

const SIM_FIELDS = [
  ['trueE', 'settings.sim.trueE', 0.01],
  ['trueN', 'settings.sim.trueN', 0.01],
  ['biasM', 'settings.sim.biasM', 0.1],
  ['biasDeg', 'settings.sim.biasDeg', 1],
  ['noiseSigma', 'settings.sim.noise', 0.1],
  ['reportedAcc', 'settings.sim.acc', 0.5],
  ['rateHz', 'settings.sim.rate', 0.5],
  ['ar1', 'settings.sim.ar1', 0.05],
];

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
      <span>${t('settings.stability')}</span>
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

    <h2>${t('settings.simulator')}</h2>
    <div class="set-row">
      <span>${t('settings.simulator')}</span>
      <input id="set-sim" type="checkbox" style="width:26px;height:26px" />
    </div>
    <div id="sim-params" class="${settings.simulator.enabled ? '' : 'hidden'}">
      ${SIM_FIELDS.map(
        ([key, label, step]) => `
      <div class="set-row">
        <span>${t(label)}</span>
        <input data-sim="${key}" type="number" inputmode="decimal" step="${step}" />
      </div>`
      ).join('')}
      <div class="set-row">
        <span>${t('settings.sim.walk')}</span>
        <span class="walk-pad">
          <button class="btn secondary walk" data-walk="0,1">↑</button>
          <button class="btn secondary walk" data-walk="-1,0">←</button>
          <button class="btn secondary walk" data-walk="1,0">→</button>
          <button class="btn secondary walk" data-walk="0,-1">↓</button>
        </span>
      </div>
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
    root.querySelector('#sim-params').classList.toggle('hidden', !simChk.checked);
    geo.restart();
  });

  root.querySelectorAll('[data-sim]').forEach((input) => {
    const key = input.dataset.sim;
    input.value = String(settings.simulator[key]);
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) return;
      settings.simulator[key] = v;
      persistSettings();
      if (settings.simulator.enabled) geo.restart();
    });
  });

  root.querySelectorAll('[data-walk]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [dE, dN] = btn.dataset.walk.split(',').map(Number);
      geo.simWalk(dE, dN);
      settings.simulator.trueE += dE;
      settings.simulator.trueN += dN;
      persistSettings();
      const eIn = root.querySelector('[data-sim="trueE"]');
      const nIn = root.querySelector('[data-sim="trueN"]');
      if (eIn) eIn.value = String(settings.simulator.trueE);
      if (nIn) nIn.value = String(settings.simulator.trueN);
    });
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
