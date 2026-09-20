// Parcel report: fetch GURS cadastre data for a list of parcels in one KO
// and print a markdown table (with area sum) plus a CSV block.
//
//   node scripts/parcel-report.mjs <KO_ID> <parcel> [<parcel> ...]
//   node scripts/parcel-report.mjs 1590 3319 2513/6 120/3 121/1 2513/5 120/4 120/5
//
// Per parcel: attributes from SI.GURS.KN:PARCELE, boundary-point counts by
// accuracy class from SI.GURS.KN:TOCKE (vertex matching, 1 cm tolerance) and
// the number of urejene segments from SI.GURS.KN:UREJENE_MEJE.

const BASE = 'https://ipi.eprostor.gov.si/wfs-si-gurs-kn/wfs';

function wfsUrl(layer, cql) {
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
  const res = await fetch(wfsUrl(layer, cql));
  if (!res.ok) throw new Error(`${layer}: HTTP ${res.status}`);
  return res.json();
}

function outerRing(geometry) {
  let ring;
  if (geometry.type === 'Polygon') ring = geometry.coordinates[0];
  else if (geometry.type === 'MultiPolygon') ring = geometry.coordinates[0][0];
  else return [];
  return ring;
}

function bbox(ring, pad) {
  let e0 = Infinity, n0 = Infinity, e1 = -Infinity, n1 = -Infinity;
  for (const [E, N] of ring) {
    e0 = Math.min(e0, E); e1 = Math.max(e1, E);
    n0 = Math.min(n0, N); n1 = Math.max(n1, N);
  }
  return [e0 - pad, n0 - pad, e1 + pad, n1 + pad];
}

const [koIdArg, ...parcels] = process.argv.slice(2);
if (!koIdArg || !parcels.length) {
  console.error('usage: node scripts/parcel-report.mjs <KO_ID> <parcel> [<parcel> ...]');
  process.exit(1);
}
const koId = Number(koIdArg);

const rows = [];
for (const st of parcels) {
  const safe = st.replace(/'/g, '');
  let feature = null;
  try {
    const fc = await get('SI.GURS.KN:PARCELE', `KO_ID=${koId} AND ST_PARCELE='${safe}'`);
    feature = fc.features?.[0] ?? null;
  } catch (e) {
    console.error(`  ! ${st}: ${e.message}`);
  }
  if (!feature) {
    rows.push({ st, missing: true });
    continue;
  }
  const p = feature.properties;
  const ring = outerRing(feature.geometry);
  const row = {
    st: String(p.ST_PARCELE),
    eid: p.EID_PARCELA,
    koName: p.NAZIV,
    area: Number(p.POVRSINA),
    status: p.UPRAVNI_STATUSI_NAZIV_SL,
    eCen: p.E_CEN,
    nCen: p.N_CEN,
    green: 0, yellow: 0, red: 0, urejene: 0,
    props: p,
  };
  if (ring.length) {
    const [e0, n0, e1, n1] = bbox(ring, 2);
    const box = `BBOX(GEOM,${e0.toFixed(2)},${n0.toFixed(2)},${e1.toFixed(2)},${n1.toFixed(2)})`;
    try {
      const [tocke, meje] = await Promise.all([
        get('SI.GURS.KN:TOCKE', box),
        get('SI.GURS.KN:UREJENE_MEJE', box),
      ]);
      for (const f of tocke.features ?? []) {
        const tp = f.properties;
        const onParcel = ring.some(
          ([vE, vN]) => Math.hypot(vE - Number(tp.E), vN - Number(tp.N)) <= 0.01
        );
        if (!onParcel) continue;
        const code = Number(tp.NATANCNOSTI_DOLOCITVE_POLOZAJA_SIFRA);
        if (code === 11) row.green++;
        else if (code === 20) row.yellow++;
        else row.red++;
      }
      row.urejene = (meje.features ?? []).length;
    } catch (e) {
      console.error(`  ! ${st} points: ${e.message}`);
    }
  }
  rows.push(row);
}

// --- markdown table ---------------------------------------------------------

const found = rows.filter((r) => !r.missing);
const sum = found.reduce((s, r) => s + (r.area || 0), 0);
const koName = found[0]?.koName ?? koId;

console.log(`\n## Parcels in KO ${koId} ${koName}\n`);
console.log('| Parcela | EID | Površina (m²) | Status | Točke (g/y/r) | Urejene meje v bbox | Centroid E | Centroid N |');
console.log('|---|---|---:|---|---|---:|---:|---:|');
for (const r of rows) {
  if (r.missing) {
    console.log(`| ${r.st} | — | — | NOT FOUND | — | — | — | — |`);
    continue;
  }
  console.log(
    `| ${r.st} | ${r.eid} | ${r.area} | ${r.status} | ${r.green} / ${r.yellow} / ${r.red} | ${r.urejene} | ${r.eCen ?? '—'} | ${r.nCen ?? '—'} |`
  );
}
console.log(`| **Σ** |  | **${sum}** |  |  |  |  |  |`);
console.log(`\nSum of area: **${sum} m²** (${(sum / 10000).toFixed(2)} ha) over ${found.length}/${rows.length} parcels found.\n`);

// --- CSV --------------------------------------------------------------------

console.log('```csv');
console.log('st_parcele,eid,povrsina_m2,status,tocke_green,tocke_yellow,tocke_red,urejene_meje_bbox,e_cen,n_cen');
for (const r of rows) {
  if (r.missing) console.log(`${r.st},,,,NOT FOUND,,,,,`);
  else console.log(`${r.st},${r.eid},${r.area},"${r.status}",${r.green},${r.yellow},${r.red},${r.urejene},${r.eCen ?? ''},${r.nCen ?? ''}`);
}
console.log('```');
