// Welcome overlay, shown on every launch (spec 6.1).

import { t } from '../../app.js';

export function showWelcome(onStart) {
  const el = document.getElementById('welcome');
  const steps = t('welcome.steps');
  el.innerHTML = `
    <h1>${t('welcome.title')}</h1>
    <ol>
      ${steps
        .map(
          (s, i) =>
            `<li><span class="n">${i + 1}</span><div><b>${s.t}</b> <span>${s.d}</span></div></li>`
        )
        .join('')}
    </ol>
    <p class="foot">${t('welcome.footer')}</p>
    <button class="btn" id="welcome-start">${t('welcome.start')}</button>
  `;
  el.classList.remove('hidden');
  el.querySelector('#welcome-start').addEventListener(
    'click',
    () => {
      el.classList.add('hidden');
      onStart?.();
    },
    { once: true }
  );
}
