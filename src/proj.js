// Coordinate conversion WGS84 <-> D96/TM (EPSG:3794).
// proj4 is loaded as a global: in the browser via <script src="vendor/proj4.js">,
// in Node tests via test/helpers/load-proj4.js.

// Definition from the spec, verbatim. proj4js has no "tm" alias for the
// transverse Mercator projection (PROJ accepts it, proj4js wants "tmerc"),
// so the alias is normalised before registering — all parameters unchanged.
export const EPSG3794_DEF =
  '+proj=tm +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

const proj4 = globalThis.proj4;
if (!proj4) throw new Error('proj4 global missing: load vendor/proj4.js first');

proj4.defs('EPSG:3794', EPSG3794_DEF.replace('+proj=tm ', '+proj=tmerc '));

/** [lon, lat] degrees -> [E, N] metres in EPSG:3794 */
export function wgsToD96(lonLat) {
  return proj4('EPSG:4326', 'EPSG:3794', lonLat);
}

/** [E, N] metres in EPSG:3794 -> [lon, lat] degrees */
export function d96ToWgs(en) {
  return proj4('EPSG:3794', 'EPSG:4326', en);
}

/** Convert a Geolocation fix to a Fix record in 3794. */
export function fixFromPosition(pos, src = 'gps') {
  const [E, N] = wgsToD96([pos.coords.longitude, pos.coords.latitude]);
  return { t: pos.timestamp, E, N, acc: pos.coords.accuracy, src };
}

/**
 * Meridian convergence at a point: the angle from grid north (3794) to true
 * north, degrees, positive east of true north. gamma ~ (lambda - 15) * sin(phi).
 */
export function convergenceDeg(lonDeg, latDeg) {
  return (lonDeg - 15) * Math.sin((latDeg * Math.PI) / 180);
}

export function dist(aE, aN, bE, bN) {
  return Math.hypot(bE - aE, bN - aN);
}
