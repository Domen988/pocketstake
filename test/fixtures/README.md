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

Status of each file:

- `parcele.json` — **real**: the live WFS feature for parcel 3319 (authentic
  EID, ring order and attributes), pasted from a live query on 2026-09-20.
- `tocke.json`, `urejene_meje.json` — still reconstructed: point EIDs are
  invented (consistent between the two files) and `*_NAZIV_SL` labels are
  plausible but not authoritative. Segment `TOCKA_ID_*` reference the
  invented point EIDs, not the real ones.

Tests only rely on the fields listed in the spec's layer table, so they keep
passing after the swap to real responses.
