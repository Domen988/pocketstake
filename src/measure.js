// Measurement logic (spec section 7). Pure — no DOM, unit tested.

import { convergenceDeg } from './proj.js';

// --- bearing ----------------------------------------------------------------

/** Grid bearing atan2(dE, dN), degrees clockwise from grid north, [0, 360). */
export function gridBearingDeg(fromE, fromN, toE, toN) {
  const b = (Math.atan2(toE - fromE, toN - fromN) * 180) / Math.PI;
  return (b + 360) % 360;
}

/**
 * True-north bearing: grid bearing + meridian convergence at the observer.
 * gamma = (lon - 15) * sin(lat) is the angle from true north to grid north
 * (positive east); a grid azimuth A_g has true azimuth A_g + gamma.
 */
export function trueBearingDeg(fromE, fromN, toE, toN, lonDeg, latDeg) {
  const g = convergenceDeg(lonDeg, latDeg);
  return (gridBearingDeg(fromE, fromN, toE, toN) + g + 360) % 360;
}

const WINDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function windName(bearingDeg) {
  return WINDS[Math.round(((bearingDeg % 360) + 360) % 360 / 22.5) % 16];
}

// --- averaging (spec 7.2) ---------------------------------------------------

const MAD_MIN_FIXES = 20;
const MAD_INTERVAL_MS = 10_000;
const MAD_K = 4 * 1.4826;
const MAD_FLOOR_M = 0.1; // guard: MAD of a very tight cluster is ~0, which would reject everything
const INDEP_S = 10; // one independent sample per ~10 s
const GAP_CAP_S = 3; // a gap in the fix stream stops counting after 3 s
const ACC_GATE = 8; // m
const ACC_WINDOW_MS = 30_000;
const FRESH_MS = 5_000; // stability needs a recent fix (stalled stream must not sit "stable")

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class Averager {
  /** threshold: stability threshold in metres (0.3 | 0.5 | 1.0). */
  constructor({ threshold = 0.5 } = {}) {
    this.threshold = threshold;
    this.fixes = []; // {t, E, N, acc, src, accepted}
    this.startedAt = null;
    this.lastMadT = null;
    this.lastBadAccT = null; // last fix with acc > 8
    this.lastGoodAccT = null;
    this.meanHistory = []; // {t, E, N} after each fix
  }

  /** Spec 7.1: fixes with acc > 25 m are discarded; no other intake rule. */
  addFix(fix) {
    if (fix.acc > 25) return false;
    if (this.startedAt === null) this.startedAt = fix.t;
    this.fixes.push({ ...fix, accepted: true });
    if (fix.acc > ACC_GATE) this.lastBadAccT = fix.t;
    else this.lastGoodAccT = fix.t;

    if (
      this.fixes.length >= MAD_MIN_FIXES &&
      (this.lastMadT === null || fix.t - this.lastMadT >= MAD_INTERVAL_MS)
    ) {
      this.#madReject();
      this.lastMadT = fix.t;
    }

    const m = this.#mean();
    if (m) this.meanHistory.push({ t: fix.t, E: m.E, N: m.N });
    return true;
  }

  /** Weighted mean (1/acc^2) and weighted std dev over accepted fixes. */
  #mean() {
    let sw = 0, se = 0, sn = 0;
    for (const f of this.fixes) {
      if (!f.accepted) continue;
      const w = 1 / (f.acc * f.acc);
      sw += w;
      se += w * f.E;
      sn += w * f.N;
    }
    if (!sw) return null;
    const E = se / sw;
    const N = sn / sw;
    let ve = 0, vn = 0;
    for (const f of this.fixes) {
      if (!f.accepted) continue;
      const w = 1 / (f.acc * f.acc);
      ve += w * (f.E - E) ** 2;
      vn += w * (f.N - N) ** 2;
    }
    return { E, N, sigmaE: Math.sqrt(ve / sw), sigmaN: Math.sqrt(vn / sw), sumW: sw };
  }

  /**
   * MAD outlier rejection, recomputed from ALL fixes each run so an earlier
   * drop can rejoin if the picture changes (self-healing). Distances are
   * measured from the componentwise MEDIAN position rather than the weighted
   * mean: a gross outlier drags the mean (and then the MAD statistics) toward
   * itself, which made the mean-based version of this rule reject good fixes.
   */
  #madReject() {
    const medE = median(this.fixes.map((f) => f.E));
    const medN = median(this.fixes.map((f) => f.N));
    const d = this.fixes.map((f) => Math.hypot(f.E - medE, f.N - medN));
    const med = median(d);
    const mad = Math.max(median(d.map((x) => Math.abs(x - med))), MAD_FLOOR_M);
    const limit = MAD_K * mad;
    this.fixes.forEach((f, i) => {
      f.accepted = d[i] <= limit;
    });
  }

  /**
   * Seconds of the stream actually covered by accepted fixes (gaps capped at
   * 3 s), so a stalled stream cannot inflate nEffective. With a continuous
   * ~1 Hz stream this tracks elapsed time. Deviation from the spec's plain
   * floor(elapsed/10), flagged in the review.
   */
  #coveredSeconds() {
    let covered = 0;
    let prev = null;
    for (const f of this.fixes) {
      if (!f.accepted) continue;
      if (prev !== null) covered += Math.min((f.t - prev) / 1000, GAP_CAP_S);
      prev = f.t;
    }
    return covered;
  }

  /** Running-mean displacement vs ~60 s ago; null while under 60 s. */
  #drift60(now) {
    const h = this.meanHistory;
    if (!h.length) return null;
    const cur = h[h.length - 1];
    const cutoff = now - 60_000;
    let past = null;
    for (const s of h) {
      if (s.t <= cutoff) past = s;
      else break;
    }
    if (!past) return null;
    return Math.hypot(cur.E - past.E, cur.N - past.N);
  }

  snapshot(now) {
    const m = this.#mean();
    const nFixes = this.fixes.length;
    const nAccepted = this.fixes.filter((f) => f.accepted).length;
    const elapsed = this.startedAt === null ? 0 : (now - this.startedAt) / 1000;
    const nEffective = Math.floor(this.#coveredSeconds() / INDEP_S);
    const sem =
      m && nEffective > 0
        ? Math.sqrt(m.sigmaE ** 2 + m.sigmaN ** 2) / Math.sqrt(nEffective)
        : null;
    const drift60 = this.#drift60(now);
    const last = this.fixes[this.fixes.length - 1] ?? null;

    // reported accuracy <= 8 m for the whole last 30 s
    const accOk30 =
      last !== null &&
      elapsed >= ACC_WINDOW_MS / 1000 &&
      (this.lastBadAccT === null || now - this.lastBadAccT >= ACC_WINDOW_MS);

    // poor sky: accuracy above 8 m with no good fix for 30 s
    const poorSky =
      last !== null &&
      this.lastBadAccT !== null &&
      (this.lastGoodAccT === null || now - this.lastGoodAccT >= ACC_WINDOW_MS) &&
      now - this.lastBadAccT < ACC_WINDOW_MS;

    const fresh = last !== null && now - last.t <= FRESH_MS;

    const stable =
      m !== null &&
      elapsed >= 90 &&
      nEffective >= 9 &&
      sem !== null &&
      sem <= this.threshold &&
      drift60 !== null &&
      drift60 <= this.threshold &&
      accOk30 &&
      fresh;

    return {
      elapsed,
      nFixes,
      nAccepted,
      nEffective,
      meanE: m?.E ?? null,
      meanN: m?.N ?? null,
      sigmaE: m?.sigmaE ?? null,
      sigmaN: m?.sigmaN ?? null,
      sem,
      drift60,
      lastAcc: last?.acc ?? null,
      accOk30,
      poorSky,
      stable,
    };
  }
}

/** Build a Measurement record (spec section 5) from a stopped averager. */
export function buildMeasurement(avg, { id, point, now, note = '' }) {
  const s = avg.snapshot(now);
  const src = avg.fixes.some((f) => f.src === 'sim') ? 'sim' : 'gps';
  const m = {
    id,
    pointEid: point ? String(point.eid) : null,
    pointNumber: point ? point.number : null,
    startedAt: avg.startedAt,
    endedAt: now,
    nFixes: s.nFixes,
    nEffective: s.nEffective,
    meanE: s.meanE,
    meanN: s.meanN,
    sigmaE: s.sigmaE,
    sigmaN: s.sigmaN,
    sem: s.sem,
    stable: s.stable,
    src,
    calibrationId: null, // phase 4
    correctedE: s.meanE,
    correctedN: s.meanN,
    offsetToTargetE: null,
    offsetToTargetN: null,
    distance: null,
    bearingTrue: null,
    revealedError: null,
    note,
  };
  if (point && s.meanE !== null) {
    m.offsetToTargetE = point.E - m.correctedE;
    m.offsetToTargetN = point.N - m.correctedN;
    m.distance = Math.hypot(m.offsetToTargetE, m.offsetToTargetN);
  }
  return m;
}
