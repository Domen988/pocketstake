import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tileOrigin, tileKey, tilesInBbox, wmsTileUrl, TILE_M, TILE_PX } from '../src/tiles.js';

test('tileOrigin aligns to the 256 m grid', () => {
  assert.deepEqual(tileOrigin(486445.84, 46488.27), [486400, 46336]);
  assert.deepEqual(tileOrigin(486400, 46336), [486400, 46336]);
  assert.deepEqual(tileOrigin(486399.99, 46335.99), [486144, 46080]);
});

test('tileKey format matches the spec', () => {
  assert.equal(tileKey('dof', 486400, 46336), 'dof/486400/46336');
  assert.equal(tileKey('kn', 486400, 46336), 'kn/486400/46336');
});

test('tilesInBbox covers the box', () => {
  const one = tilesInBbox([486450, 46400, 486460, 46410]);
  assert.deepEqual(one, [[486400, 46336]]);
  // a 500 m box spans 2-3 tiles per axis depending on alignment
  const many = tilesInBbox([486450 - 250, 46470 - 250, 486450 + 250, 46470 + 250]);
  assert.ok(many.length >= 4 && many.length <= 9, `${many.length} tiles`);
  for (const [E0, N0] of many) {
    assert.equal(E0 % TILE_M, 0);
    assert.equal(N0 % TILE_M, 0);
  }
});

test('wmsTileUrl: WMS 1.1.1, EPSG:3794, E-first bbox, 1024 px', () => {
  const dof = new URL(wmsTileUrl('dof', 486400, 46336));
  assert.equal(dof.origin + dof.pathname, 'https://ipi.eprostor.gov.si/wms-si-gurs-dts/wms');
  assert.equal(dof.searchParams.get('version'), '1.1.1');
  assert.equal(dof.searchParams.get('srs'), 'EPSG:3794');
  assert.equal(dof.searchParams.get('layers'), 'SI.GURS.ZPDZ:DOF025');
  assert.equal(dof.searchParams.get('bbox'), '486400,46336,486656,46592');
  assert.equal(dof.searchParams.get('width'), String(TILE_PX));
  assert.equal(dof.searchParams.get('transparent'), null);

  const kn = new URL(wmsTileUrl('kn', 486400, 46336));
  assert.equal(kn.origin + kn.pathname, 'https://ipi.eprostor.gov.si/wms-si-gurs-kn/wms');
  assert.equal(kn.searchParams.get('layers'), 'SI.GURS.KN:PARCELE');
  assert.equal(kn.searchParams.get('transparent'), 'true');
});
