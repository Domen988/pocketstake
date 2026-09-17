// GPS simulator (spec 9.1): true position + bias vector + AR(1)-correlated
// noise, emitted at a fixed rate as fixes with src 'sim'.

/** Deterministic RNG (mulberry32) so tests are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller. */
export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export class Simulator {
  constructor(params, rng = Math.random) {
    this.p = { ...params };
    this.rng = rng;
    this.errE = 0;
    this.errN = 0;
    this.timer = null;
  }

  /** Next fix. AR(1): err = a*err + sqrt(1-a^2)*N(0, sigma), stationary sigma. */
  nextFix(t = Date.now()) {
    const { ar1, noiseSigma, biasM, biasDeg, trueE, trueN, reportedAcc } = this.p;
    const s = Math.sqrt(1 - ar1 * ar1) * noiseSigma;
    this.errE = ar1 * this.errE + s * gaussian(this.rng);
    this.errN = ar1 * this.errN + s * gaussian(this.rng);
    const rad = (biasDeg * Math.PI) / 180;
    return {
      t,
      E: trueE + biasM * Math.sin(rad) + this.errE,
      N: trueN + biasM * Math.cos(rad) + this.errN,
      acc: reportedAcc,
      src: 'sim',
    };
  }

  start(onFix) {
    this.stop();
    const interval = 1000 / (this.p.rateHz || 1);
    this.timer = setInterval(() => onFix(this.nextFix()), interval);
    onFix(this.nextFix());
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Walk control: move the true position by (dE, dN) metres. */
  walk(dE, dN) {
    this.p.trueE += dE;
    this.p.trueN += dN;
  }
}
