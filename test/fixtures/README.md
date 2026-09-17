# Test fixtures — KO 1590 Kočevska Reka, parcel 3319

**These files are reconstructed** from the verified data table in the spec
(section 4.3), shaped like GeoServer WFS 2.0 GeoJSON responses. The GURS
endpoints were not reachable from the build environment.

To replace them with the real raw responses, run once with network access:

```
npm run fixtures
```

(`scripts/fetch-fixtures.mjs` overwrites `parcele.json`, `tocke.json` and
`urejene_meje.json` with the live WFS output.)

Known deviations of the reconstruction from live data:

- Feature `id`s and EIDs are invented (consistent between files).
- The polygon ring order is inferred (shoelace area 499.4 m² vs the recorded
  POVRSINA of 493 m²); attribute `POVRSINA` carries the recorded value.
- `*_NAZIV_SL` labels are plausible but not authoritative.

Tests only rely on the fields listed in the spec's layer table, so they keep
passing after the swap to real responses.
