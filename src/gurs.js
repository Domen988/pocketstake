// GURS WFS access and parsing into the app's data model.
// Only the three permitted layers are ever requested.

export const WFS_BASE = 'https://ipi.eprostor.gov.si/wfs-si-gurs-kn/wfs';

export const LAYER_PARCELE = 'SI.GURS.KN:PARCELE';
export const LAYER_TOCKE = 'SI.GURS.KN:TOCKE';
export const LAYER_UREJENE_MEJE = 'SI.GURS.KN:UREJENE_MEJE';

const ALLOWED_LAYERS = new Set([LAYER_PARCELE, LAYER_TOCKE, LAYER_UREJENE_MEJE]);

export function wfsUrl(layer, cqlFilter) {
  if (!ALLOWED_LAYERS.has(layer)) throw new Error('layer not allowed: ' + layer);
  const p = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    outputFormat: 'application/json',
    typeNames: layer,
    cql_filter: cqlFilter,
  });
  return `${WFS_BASE}?${p}`;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WFS ${res.status}`);
  return res.json();
}

// --- geometry helpers -------------------------------------------------------

/** Outer ring of a Polygon/MultiPolygon geometry, closing vertex removed. */
export function outerRing(geometry) {
  let ring;
  if (geometry.type === 'Polygon') ring = geometry.coordinates[0];
  else if (geometry.type === 'MultiPolygon') ring = geometry.coordinates[0][0];
  else throw new Error('unexpected geometry ' + geometry.type);
  const [x0, y0] = ring[0];
  const [xn, yn] = ring[ring.length - 1];
  if (x0 === xn && y0 === yn) ring = ring.slice(0, -1);
  return ring.map(([E, N]) => [E, N]);
}

/** [Emin, Nmin, Emax, Nmax] of a ring, padded by pad metres. */
export function ringBbox(ring, pad = 0) {
  let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
  for (const [E, N] of ring) {
    if (E < e0) e0 = E;
    if (E > e1) e1 = E;
    if (N < n0) n0 = N;
    if (N > n1) n1 = N;
  }
  return [e0 - pad, n0 - pad, e1 + pad, n1 + pad];
}

// --- parsing ----------------------------------------------------------------

export function accColour(accCode) {
  if (accCode === 11) return 'green';
  if (accCode === 20) return 'yellow';
  return 'red';
}

export function parseParcel(geojson) {
  const f = geojson.features?.[0];
  if (!f) return null;
  const p = f.properties;
  return {
    eid: p.EID_PARCELA,
    koId: Number(p.KO_ID),
    koName: p.NAZIV,
    number: String(p.ST_PARCELE),
    area: Number(p.POVRSINA),
    status: p.UPRAVNI_STATUSI_NAZIV_SL,
    ring: outerRing(f.geometry),
    loadedAt: Date.now(),
  };
}

/**
 * Parse a TOCKE response. A point belongs to the parcel when its (E, N) is
 * within tolM metres of a ring vertex (default 1 cm; float-safe version of
 * the spec's "round to 2 decimals" rule). Others are neighbour points.
 */
export function parsePoints(geojson, parcelRing, tolM = 0.01) {
  return (geojson.features ?? []).map((f) => {
    const p = f.properties;
    const E = Number(p.E);
    const N = Number(p.N);
    const accCode = Number(p.NATANCNOSTI_DOLOCITVE_POLOZAJA_SIFRA);
    const onParcel = parcelRing
      ? parcelRing.some(([vE, vN]) => Math.hypot(vE - E, vN - N) <= tolM)
      : false;
    return {
      eid: p.EID_TOCKA,
      koId: Number(p.KO_ID),
      number: String(p.ST_TOCKE),
      E,
      N,
      accCode,
      accName: p.NATANCNOSTI_DOLOCITVE_POLOZAJA_NAZIV_SL ?? '',
      methodCode: Number(p.METODE_DOLOCITVE_POLOZAJA_SIFRA),
      methodName: p.METODE_DOLOCITVE_POLOZAJA_NAZIV_SL ?? '',
      statusCode: Number(p.UPRAVNI_STATUSI_TOCK_SIFRA),
      statusName: p.UPRAVNI_STATUSI_TOCK_NAZIV_SL ?? '',
      marking: p.NACINI_OZNACITVE_TOCK_NAZIV_SL ?? '',
      colour: accColour(accCode),
      onParcel,
      kind: 'cadastre',
      foundPhysically: false,
    };
  });
}

/** Parse UREJENE_MEJE, keeping only segments whose both endpoints are known points. */
export function parseSegments(geojson, points) {
  const byEid = new Set(points.map((p) => String(p.eid)));
  return (geojson.features ?? [])
    .map((f) => ({
      fromEid: String(f.properties.TOCKA_ID_ZAC),
      toEid: String(f.properties.TOCKA_ID_KON),
      urejena: f.properties.UPRAVNI_STATUSI_NAZIV_SL === 'urejena',
      line: f.geometry?.type === 'LineString' ? f.geometry.coordinates : null,
    }))
    .filter((s) => byEid.has(s.fromEid) && byEid.has(s.toEid));
}

// --- fetchers ---------------------------------------------------------------

export async function fetchParcelByNumber(koId, stParcele) {
  const url = wfsUrl(LAYER_PARCELE, `KO_ID=${Number(koId)} AND ST_PARCELE='${String(stParcele).replace(/'/g, '')}'`);
  return parseParcel(await getJson(url));
}

export async function fetchParcelAtPoint(E, N) {
  const url = wfsUrl(
    LAYER_PARCELE,
    `BBOX(GEOM,${(E - 0.5).toFixed(2)},${(N - 0.5).toFixed(2)},${(E + 0.5).toFixed(2)},${(N + 0.5).toFixed(2)})`
  );
  return parseParcel(await getJson(url));
}

/** Fetch points + segments for a parcel: BBOX around its ring padded 2 m. */
export async function fetchPointsAndSegments(parcel, tolM = 0.01) {
  const [e0, n0, e1, n1] = ringBbox(parcel.ring, 2);
  const bbox = `BBOX(GEOM,${e0.toFixed(2)},${n0.toFixed(2)},${e1.toFixed(2)},${n1.toFixed(2)})`;
  const [tocke, meje] = await Promise.all([
    getJson(wfsUrl(LAYER_TOCKE, bbox)),
    getJson(wfsUrl(LAYER_UREJENE_MEJE, bbox)),
  ]);
  const points = parsePoints(tocke, parcel.ring, tolM);
  const segments = parseSegments(meje, points);
  return { points, segments, raw: { tocke, meje } };
}
