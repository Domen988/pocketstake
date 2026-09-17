import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseParcel,
  parsePoints,
  parseSegments,
  outerRing,
  ringBbox,
  accColour,
  wfsUrl,
  LAYER_PARCELE,
} from '../src/gurs.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const parcele = load('parcele.json');
const tocke = load('tocke.json');
const meje = load('urejene_meje.json');

test('parseParcel: fixture parcel 3319', () => {
  const p = parseParcel(parcele);
  assert.equal(p.koId, 1590);
  assert.equal(p.number, '3319');
  assert.equal(p.area, 493);
  assert.equal(p.status, 'ni urejena');
  assert.equal(p.ring.length, 9, 'closing vertex removed, 9 unique vertices');
});

test('parsePoints: 9 points on parcel, colour split 2 green / 1 yellow / 6 red', () => {
  const parcel = parseParcel(parcele);
  const points = parsePoints(tocke, parcel.ring, 0.01);
  assert.equal(points.length, 9);
  assert.ok(points.every((p) => p.onParcel));
  const c = { green: 0, yellow: 0, red: 0 };
  for (const p of points) c[p.colour]++;
  assert.deepEqual(c, { green: 2, yellow: 1, red: 6 });
});

test('vertex matching honours the tolerance', () => {
  const parcel = parseParcel(parcele);
  const mk = (E, N) => ({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          EID_TOCKA: 'X',
          KO_ID: 1590,
          ST_TOCKE: 'X',
          E,
          N,
          NATANCNOSTI_DOLOCITVE_POLOZAJA_SIFRA: 11,
          METODE_DOLOCITVE_POLOZAJA_SIFRA: 91,
          UPRAVNI_STATUSI_TOCK_SIFRA: 1,
        },
      },
    ],
  });
  // 0.5 cm off a vertex: matches at 1 cm tolerance
  assert.ok(parsePoints(mk(486445.845, 46488.27), parcel.ring, 0.01)[0].onParcel);
  // 5 cm off: neighbour at 1 cm tolerance, vertex at 10 cm tolerance
  assert.ok(!parsePoints(mk(486445.89, 46488.27), parcel.ring, 0.01)[0].onParcel);
  assert.ok(parsePoints(mk(486445.89, 46488.27), parcel.ring, 0.1)[0].onParcel);
});

test('neighbour point in bbox is kept but not onParcel', () => {
  const parcel = parseParcel(parcele);
  const neighbour = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          EID_TOCKA: 'N1',
          KO_ID: 1590,
          ST_TOCKE: '99999',
          E: 486470.0,
          N: 46490.0,
          NATANCNOSTI_DOLOCITVE_POLOZAJA_SIFRA: 20,
          METODE_DOLOCITVE_POLOZAJA_SIFRA: 92,
          UPRAVNI_STATUSI_TOCK_SIFRA: 2,
        },
      },
    ],
  };
  const [p] = parsePoints(neighbour, parcel.ring, 0.01);
  assert.equal(p.onParcel, false);
  assert.equal(p.colour, 'yellow');
});

test('parseSegments: the two urejene segments of the fixture', () => {
  const parcel = parseParcel(parcele);
  const points = parsePoints(tocke, parcel.ring, 0.01);
  const segments = parseSegments(meje, points);
  assert.equal(segments.length, 2);
  assert.ok(segments.every((s) => s.urejena));
  const pairs = segments.map((s) => `${s.fromEid}->${s.toEid}`).sort();
  assert.deepEqual(pairs, ['159019166->159019167', '159019167->159014130']);
});

test('segments with unknown endpoints are dropped', () => {
  const parcel = parseParcel(parcele);
  const points = parsePoints(tocke, parcel.ring, 0.01);
  const foreign = {
    type: 'FeatureCollection',
    features: [
      ...meje.features,
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
        properties: { TOCKA_ID_ZAC: 'ZZZ', TOCKA_ID_KON: '159019167', UPRAVNI_STATUSI_NAZIV_SL: 'urejena' },
      },
    ],
  };
  assert.equal(parseSegments(foreign, points).length, 2);
});

test('accColour mapping', () => {
  assert.equal(accColour(11), 'green');
  assert.equal(accColour(20), 'yellow');
  assert.equal(accColour(99), 'red');
  assert.equal(accColour(0), 'red');
});

test('outerRing handles MultiPolygon and unclosed rings', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.deepEqual(outerRing({ type: 'Polygon', coordinates: [[...ring, ring[0]]] }), ring);
  assert.deepEqual(outerRing({ type: 'MultiPolygon', coordinates: [[[...ring, ring[0]]]] }), ring);
  assert.deepEqual(outerRing({ type: 'Polygon', coordinates: [ring] }), ring);
});

test('ringBbox pads correctly', () => {
  const parcel = parseParcel(parcele);
  const [e0, n0, e1, n1] = ringBbox(parcel.ring, 2);
  assert.equal(e0, 486433.84 - 2);
  assert.equal(n0, 46462.82 - 2);
  assert.equal(e1, 486468.03 + 2);
  assert.equal(n1, 46488.27 + 2);
});

test('wfsUrl: correct query, only permitted layers', () => {
  const u = new URL(wfsUrl(LAYER_PARCELE, "KO_ID=1590 AND ST_PARCELE='3319'"));
  assert.equal(u.origin + u.pathname, 'https://ipi.eprostor.gov.si/wfs-si-gurs-kn/wfs');
  assert.equal(u.searchParams.get('version'), '2.0.0');
  assert.equal(u.searchParams.get('outputFormat'), 'application/json');
  assert.equal(u.searchParams.get('typeNames'), 'SI.GURS.KN:PARCELE');
  assert.throws(() => wfsUrl('SI.GURS.KN:LASTNIKI', 'X'), /not allowed/);
});
