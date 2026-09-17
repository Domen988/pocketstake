// Device heading (spec 7.4).
//
// Platform paths, documented per spec:
// - iOS Safari: `deviceorientation` events carry `webkitCompassHeading`,
//   already TRUE-north referenced (0 = true north, clockwise). Accuracy from
//   `webkitCompassAccuracy`. Requires DeviceOrientationEvent.requestPermission()
//   from a user gesture, once per page load.
// - Android Chrome: `deviceorientationabsolute` gives `alpha` relative to
//   MAGNETIC north (heading = 360 - alpha, clockwise). Corrected here by the
//   magnetic declination for Slovenia (~ +4° E, 2026) to get true heading.
//   No permission prompt.
// - Neither available -> headingTrue stays null; the UI shows bearing numbers
//   and a north-up radar only.

export const DECLINATION_SI_DEG = 4; // magnetic -> true, Slovenia ~2026

export const compass = {
  headingTrue: null, // degrees clockwise from true north
  accuracyDeg: null, // reported heading accuracy; null = unknown
  source: null, // 'ios' | 'android' | null
  needsPermission:
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function',
  started: false,
  listeners: new Set(),

  onChange(fn) {
    this.listeners.add(fn);
  },

  _emit() {
    for (const fn of this.listeners) fn(this);
  },

  /** Must be called from a user gesture on iOS. Resolves true if heading may arrive. */
  async start() {
    if (this.started) return true;
    if (typeof DeviceOrientationEvent === 'undefined') return false;
    if (this.needsPermission) {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') return false;
      } catch {
        return false;
      }
    }
    const onIOS = (e) => {
      if (e.webkitCompassHeading == null) return;
      this.headingTrue = e.webkitCompassHeading;
      this.accuracyDeg = e.webkitCompassAccuracy > 0 ? e.webkitCompassAccuracy : null;
      this.source = 'ios';
      this._emit();
    };
    const onAbsolute = (e) => {
      if (e.alpha == null || this.source === 'ios') return;
      if (!e.absolute) return;
      this.headingTrue = (360 - e.alpha + DECLINATION_SI_DEG + 360) % 360;
      this.accuracyDeg = null; // Android reports none; UI uses the ±15° default
      this.source = 'android';
      this._emit();
    };
    window.addEventListener('deviceorientation', onIOS);
    window.addEventListener('deviceorientationabsolute', onAbsolute);
    this.started = true;
    return true;
  },
};

/** Wedge half-width for the arrow: reported accuracy, else the ±15° default. */
export function wedgeDeg(c = compass) {
  return c.accuracyDeg ?? 15;
}
