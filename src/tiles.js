// WMS tiles: fixed 256 m x 256 m squares aligned to a 256 m grid in EPSG:3794,
// requested at 1024 x 1024 px (25 cm/px) and cached in IndexedDB as blobs.

import { idbGet, idbPut, idbDelete, idbKeys } from './store.js';

export const TILE_M = 256;
export const TILE_PX = 1024;

const WMS_DOF = 'https://ipi.eprostor.gov.si/wms-si-gurs-dts/wms';
const WMS_KN = 'https://ipi.eprostor.gov.si/wms-si-gurs-kn/wms';

/** Grid origin (SW corner) of the tile containing (E, N). */
export function tileOrigin(E, N) {
  return [Math.floor(E / TILE_M) * TILE_M, Math.floor(N / TILE_M) * TILE_M];
}

export function tileKey(kind, E0, N0) {
  return `${kind}/${E0}/${N0}`;
}

/** All tile origins intersecting bbox [Emin, Nmin, Emax, Nmax]. */
export function tilesInBbox([e0, n0, e1, n1]) {
  const out = [];
  const [se, sn] = tileOrigin(e0, n0);
  for (let E = se; E < e1; E += TILE_M) {
    for (let N = sn; N < n1; N += TILE_M) out.push([E, N]);
  }
  return out;
}

/** WMS 1.1.1 GetMap URL for one tile. kind: 'dof' | 'kn'. */
export function wmsTileUrl(kind, E0, N0) {
  const dof = kind === 'dof';
  const p = new URLSearchParams({
    service: 'WMS',
    version: '1.1.1', // 1.3.0 returned a blank image (axis order); do not use
    request: 'GetMap',
    layers: dof ? 'SI.GURS.ZPDZ:DOF025' : 'SI.GURS.KN:PARCELE',
    styles: '',
    srs: 'EPSG:3794',
    bbox: `${E0},${N0},${E0 + TILE_M},${N0 + TILE_M}`,
    width: String(TILE_PX),
    height: String(TILE_PX),
    format: 'image/png',
  });
  if (!dof) p.set('transparent', 'true');
  return `${dof ? WMS_DOF : WMS_KN}?${p}`;
}

// --- cache ------------------------------------------------------------------

const MEM_MAX = 24; // decoded bitmaps kept in RAM (iPhone SE memory budget)

export class TileCache {
  constructor() {
    this.mem = new Map(); // key -> ImageBitmap (insertion order = LRU)
    this.pending = new Map(); // key -> Promise
    this.missing = new Set(); // keys that failed this session (offline)
  }

  /** Bitmap if instantly available; otherwise kicks off a load and returns null. */
  getNow(kind, E0, N0, onReady) {
    const key = tileKey(kind, E0, N0);
    const hit = this.mem.get(key);
    if (hit) {
      this.mem.delete(key);
      this.mem.set(key, hit); // refresh LRU position
      return hit;
    }
    if (!this.pending.has(key) && !this.missing.has(key)) {
      const p = this.#load(kind, E0, N0, key)
        .then((bmp) => {
          if (bmp) onReady?.();
          return bmp;
        })
        .catch(() => {
          this.missing.add(key);
          return null;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return null;
  }

  async #load(kind, E0, N0, key) {
    let blob = await idbGet('tiles', key);
    if (!blob) {
      if (!navigator.onLine) {
        this.missing.add(key);
        return null;
      }
      const res = await fetch(wmsTileUrl(kind, E0, N0));
      if (!res.ok) throw new Error(`WMS ${res.status}`);
      blob = await res.blob();
      await idbPut('tiles', key, blob);
    }
    const bmp = await createImageBitmap(blob);
    this.mem.set(key, bmp);
    while (this.mem.size > MEM_MAX) {
      const [oldKey, oldBmp] = this.mem.entries().next().value;
      this.mem.delete(oldKey);
      oldBmp.close?.();
    }
    return bmp;
  }

  /** Retry tiles that failed earlier (e.g. after coming back online). */
  clearMissing() {
    this.missing.clear();
  }
}

// --- prepare offline --------------------------------------------------------

/**
 * Download and store all dof + kn tiles for a square box (half metres) around
 * (E, N). Reports progress via onProgress(done, total). Returns stored byte size.
 */
export async function prepareOfflineTiles(E, N, half = 250, onProgress) {
  const origins = tilesInBbox([E - half, N - half, E + half, N + half]);
  const jobs = [];
  for (const [E0, N0] of origins) for (const kind of ['dof', 'kn']) jobs.push([kind, E0, N0]);
  let done = 0;
  let bytes = 0;
  for (const [kind, E0, N0] of jobs) {
    const key = tileKey(kind, E0, N0);
    let blob = await idbGet('tiles', key);
    if (!blob) {
      const res = await fetch(wmsTileUrl(kind, E0, N0));
      if (!res.ok) throw new Error(`WMS ${res.status}`);
      blob = await res.blob();
      await idbPut('tiles', key, blob);
    }
    bytes += blob.size;
    done += 1;
    onProgress?.(done, jobs.length);
  }
  return bytes;
}

/** Delete all stored tiles inside the box of a prepared area. */
export async function deleteOfflineTiles(E, N, half = 250) {
  const origins = tilesInBbox([E - half, N - half, E + half, N + half]);
  for (const [E0, N0] of origins) {
    await idbDelete('tiles', tileKey('dof', E0, N0));
    await idbDelete('tiles', tileKey('kn', E0, N0));
  }
}

export async function storedTileCount() {
  return (await idbKeys('tiles')).length;
}
