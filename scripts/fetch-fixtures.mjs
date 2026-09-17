// Fetch the raw WFS responses for the fixture parcel (KO 1590, parcel 3319)
// and overwrite test/fixtures/*.json with them, so tests never hit GURS.
// Run once with network access: npm run fixtures

import { writeFileSync } from 'node:fs';

const BASE = 'https://ipi.eprostor.gov.si/wfs-si-gurs-kn/wfs';

function url(layer, cql) {
  const p = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    outputFormat: 'application/json',
    typeNames: layer,
    cql_filter: cql,
  });
  return `${BASE}?${p}`;
}

async function get(layer, cql) {
  const res = await fetch(url(layer, cql));
  if (!res.ok) throw new Error(`${layer}: HTTP ${res.status}`);
  return res.json();
}

const parcele = await get('SI.GURS.KN:PARCELE', "KO_ID=1590 AND ST_PARCELE='3319'");
const f = parcele.features?.[0];
if (!f) throw new Error('fixture parcel not found');

let ring = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
for (const [E, N] of ring) {
  e0 = Math.min(e0, E); e1 = Math.max(e1, E);
  n0 = Math.min(n0, N); n1 = Math.max(n1, N);
}
const bbox = `BBOX(GEOM,${(e0 - 2).toFixed(2)},${(n0 - 2).toFixed(2)},${(e1 + 2).toFixed(2)},${(n1 + 2).toFixed(2)})`;

const tocke = await get('SI.GURS.KN:TOCKE', bbox);
const meje = await get('SI.GURS.KN:UREJENE_MEJE', bbox);

writeFileSync('test/fixtures/parcele.json', JSON.stringify(parcele, null, 2) + '\n');
writeFileSync('test/fixtures/tocke.json', JSON.stringify(tocke, null, 2) + '\n');
writeFileSync('test/fixtures/urejene_meje.json', JSON.stringify(meje, null, 2) + '\n');
console.log(`parcele: ${parcele.features.length}, tocke: ${tocke.features.length}, urejene_meje: ${meje.features.length}`);
console.log('test/fixtures/*.json updated with live WFS responses');
