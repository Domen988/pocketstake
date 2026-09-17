import './helpers/load-proj4.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wgsToD96, d96ToWgs, convergenceDeg, dist } from '../src/proj.js';

const tocke = JSON.parse(readFileSync(new URL('./fixtures/tocke.json', import.meta.url)));

test('round-trip 3794 -> WGS84 -> 3794 on all fixture points', () => {
  for (const f of tocke.features) {
    const { E, N } = f.properties;
    const [rE, rN] = wgsToD96(d96ToWgs([E, N]));
    assert.ok(dist(E, N, rE, rN) < 1e-6, `point ${f.properties.ST_TOCKE}`);
  }
});

test('fixture point 19167 lands near Kočevska Reka', () => {
  const [lon, lat] = d96ToWgs([486445.84, 46488.27]);
  assert.ok(Math.abs(lon - 14.8264) < 0.001, `lon ${lon}`);
  assert.ok(Math.abs(lat - 45.5582) < 0.001, `lat ${lat}`);
});

test('WGS84 within Slovenia converts to plausible 3794 metres', () => {
  // Ljubljana centre, roughly
  const [E, N] = wgsToD96([14.5058, 46.0569]);
  assert.ok(E > 400000 && E < 600000, `E ${E}`);
  assert.ok(N > 30000 && N < 200000, `N ${N}`);
});

test('meridian convergence: zero on the central meridian, ~ -0.13° at the fixture', () => {
  assert.equal(convergenceDeg(15, 46), 0);
  const g = convergenceDeg(14.8264, 45.5582);
  assert.ok(Math.abs(g - (14.8264 - 15) * Math.sin((45.5582 * Math.PI) / 180)) < 1e-12);
  assert.ok(g < 0 && g > -0.2, `gamma ${g}`); // west of 15°E -> grid north west of true north
});
