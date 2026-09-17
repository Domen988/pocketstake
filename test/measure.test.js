import './helpers/load-proj4.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Averager, buildMeasurement, gridBearingDeg, trueBearingDeg, windName } from '../src/measure.js';
import { mulberry32, gaussian, Simulator } from '../src/sim.js';

const T0 = 1_700_000_000_000;

/** Feed a 1 Hz stream for `seconds`, positions from fn(i) -> [E, N, acc]. */
function feed(avg, seconds, fn) {
  for (let i = 0; i < seconds; i++) {
    const [E, N, acc = 4] = fn(i);
    avg.addFix({ t: T0 + i * 1000, E, N, acc, src: 'sim' });
  }
  return T0 + (seconds - 1) * 1000;
}

// --- bearing ----------------------------------------------------------------

test('gridBearingDeg cardinal directions', () => {
  assert.equal(gridBearingDeg(0, 0, 0, 10), 0);
  assert.equal(gridBearingDeg(0, 0, 10, 0), 90);
  assert.equal(gridBearingDeg(0, 0, 0, -10), 180);
  assert.equal(gridBearingDeg(0, 0, -10, 0), 270);
});

test('trueBearingDeg applies meridian convergence', () => {
  // at the fixture (14.826°E, 45.558°N) gamma ~ -0.124°: true = grid + gamma
  const g = trueBearingDeg(0, 0, 0, 10, 14.8264, 45.5582);
  const gamma = (14.8264 - 15) * Math.sin((45.5582 * Math.PI) / 180);
  assert.ok(Math.abs(g - ((0 + gamma + 360) % 360)) < 1e-9);
  // on the central meridian there is no correction
  assert.equal(trueBearingDeg(0, 0, 10, 0, 15, 46), 90);
});

test('windName 16-wind rose', () => {
  assert.equal(windName(0), 'N');
  assert.equal(windName(347), 'NNW');
  assert.equal(windName(90), 'E');
  assert.equal(windName(225), 'SW');
  assert.equal(windName(359), 'N');
});

// --- averaging --------------------------------------------------------------

test('weighted mean weights by 1/acc²', () => {
  const avg = new Averager();
  avg.addFix({ t: T0, E: 0, N: 0, acc: 2, src: 'sim' });
  avg.addFix({ t: T0 + 1000, E: 4, N: 0, acc: 4, src: 'sim' });
  const s = avg.snapshot(T0 + 1000);
  // weights 1/4 and 1/16 -> mean = 4 * (1/16) / (5/16) = 0.8
  assert.ok(Math.abs(s.meanE - 0.8) < 1e-9);
  assert.equal(s.meanN, 0);
});

test('fixes with accuracy > 25 m are discarded at intake', () => {
  const avg = new Averager();
  assert.equal(avg.addFix({ t: T0, E: 0, N: 0, acc: 26, src: 'sim' }), false);
  assert.equal(avg.snapshot(T0).nFixes, 0);
});

test('MAD rejection drops a far outlier, keeps the cluster', () => {
  const avg = new Averager();
  const rng = mulberry32(7);
  feed(avg, 40, (i) => {
    if (i === 25) return [50, 50, 4]; // gross outlier
    return [gaussian(rng) * 0.5, gaussian(rng) * 0.5, 4];
  });
  const s = avg.snapshot(T0 + 39_000);
  assert.equal(s.nFixes, 40);
  assert.ok(s.nAccepted >= 38 && s.nAccepted <= 39, `outlier rejected (${s.nAccepted}/40 kept)`);
  assert.equal(avg.fixes[25].accepted, false, 'the gross outlier is the one rejected');
  assert.ok(Math.hypot(s.meanE, s.meanN) < 0.5, 'mean unaffected by outlier');
});

test('tight stream becomes stable after ~100 s, not before 90 s', () => {
  const avg = new Averager({ threshold: 0.5 });
  const rng = mulberry32(42);
  feed(avg, 80, () => [gaussian(rng) * 0.8, gaussian(rng) * 0.8, 4]);
  assert.equal(avg.snapshot(T0 + 79_000).stable, false, 'not stable at 80 s');
  const avg2 = new Averager({ threshold: 0.5 });
  const rng2 = mulberry32(42);
  const end = feed(avg2, 105, () => [gaussian(rng2) * 0.8, gaussian(rng2) * 0.8, 4]);
  const s = avg2.snapshot(end);
  assert.ok(s.elapsed >= 90);
  assert.ok(s.nEffective >= 9, `nEffective ${s.nEffective}`);
  assert.ok(s.sem <= 0.5, `sem ${s.sem}`);
  assert.equal(s.stable, true);
});

test('drifting stream never stabilises (drift60 above threshold)', () => {
  const avg = new Averager({ threshold: 0.5 });
  const rng = mulberry32(3);
  // mean wanders 0.05 m/s -> the 60 s drift of the running mean stays large
  const end = feed(avg, 240, (i) => [i * 0.05 + gaussian(rng) * 0.5, 0, 4]);
  const s = avg.snapshot(end);
  assert.ok(s.drift60 > 0.5, `drift60 ${s.drift60}`);
  assert.equal(s.stable, false);
});

test('poor reported accuracy blocks stability and flags poor sky', () => {
  const avg = new Averager({ threshold: 0.5 });
  const rng = mulberry32(9);
  const end = feed(avg, 120, () => [gaussian(rng) * 0.8, gaussian(rng) * 0.8, 12]);
  const s = avg.snapshot(end);
  assert.equal(s.accOk30, false);
  assert.equal(s.poorSky, true);
  assert.equal(s.stable, false);
});

test('a stalled stream cannot sit at stable (freshness + covered time)', () => {
  const avg = new Averager({ threshold: 0.5 });
  const rng = mulberry32(5);
  const end = feed(avg, 100, () => [gaussian(rng) * 0.8, gaussian(rng) * 0.8, 4]);
  assert.equal(avg.snapshot(end).stable, true);
  // 30 s later with no new fixes: stale
  const s = avg.snapshot(end + 30_000);
  assert.equal(s.stable, false);
  // and nEffective did not grow while nothing arrived
  assert.equal(s.nEffective, avg.snapshot(end).nEffective);
});

test('buildMeasurement computes the offset to the target', () => {
  const avg = new Averager({ threshold: 0.5 });
  const end = feed(avg, 95, () => [100, 200, 4]);
  const point = { eid: 'X', number: '19167', E: 103, N: 204 };
  const m = buildMeasurement(avg, { id: 'm1', point, now: end });
  assert.ok(Math.abs(m.offsetToTargetE - 3) < 1e-9);
  assert.ok(Math.abs(m.offsetToTargetN - 4) < 1e-9);
  assert.ok(Math.abs(m.distance - 5) < 1e-9);
  assert.equal(m.src, 'sim');
  assert.equal(m.pointEid, 'X');
});

// --- simulator --------------------------------------------------------------

test('simulator: mean of many fixes approaches true + bias (1.8 m at 40°)', () => {
  const sim = new Simulator(
    { trueE: 100, trueN: 200, biasM: 1.8, biasDeg: 40, noiseSigma: 2.5, reportedAcc: 4, rateHz: 1, ar1: 0.9 },
    mulberry32(11)
  );
  let se = 0, sn = 0;
  const n = 5000;
  for (let i = 0; i < n; i++) {
    const f = sim.nextFix(T0 + i * 1000);
    se += f.E;
    sn += f.N;
  }
  const dE = se / n - 100;
  const dN = sn / n - 200;
  const expE = 1.8 * Math.sin((40 * Math.PI) / 180);
  const expN = 1.8 * Math.cos((40 * Math.PI) / 180);
  assert.ok(Math.abs(dE - expE) < 0.3, `dE ${dE} vs ${expE}`);
  assert.ok(Math.abs(dN - expN) < 0.3, `dN ${dN} vs ${expN}`);
});

test('simulator: AR(1) makes consecutive fixes correlated', () => {
  const sim = new Simulator(
    { trueE: 0, trueN: 0, biasM: 0, biasDeg: 0, noiseSigma: 2.5, reportedAcc: 4, rateHz: 1, ar1: 0.9 },
    mulberry32(13)
  );
  const xs = [];
  for (let i = 0; i < 3000; i++) xs.push(sim.nextFix(T0 + i * 1000).E);
  const mean = xs.reduce((a, b) => a + b) / xs.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) {
    den += (xs[i] - mean) ** 2;
    if (i) num += (xs[i] - mean) * (xs[i - 1] - mean);
  }
  const rho = num / den;
  assert.ok(rho > 0.8, `lag-1 autocorrelation ${rho}`);
});

test('simulator walk moves the true position', () => {
  const sim = new Simulator(
    { trueE: 10, trueN: 20, biasM: 0, biasDeg: 0, noiseSigma: 0.0001, reportedAcc: 4, rateHz: 1, ar1: 0 },
    mulberry32(17)
  );
  sim.walk(1, 0);
  sim.walk(0, -1);
  const f = sim.nextFix(T0);
  assert.ok(Math.abs(f.E - 11) < 0.01);
  assert.ok(Math.abs(f.N - 19) < 0.01);
});
