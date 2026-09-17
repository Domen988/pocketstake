// IndexedDB (tiles + parcel data + prepared areas) and localStorage
// (settings, found flags, measurement log). Safari's first open can fail
// spuriously, so opens are retried.

const DB_NAME = 'pegged';
const DB_VERSION = 1;
const STORES = ['tiles', 'parcels', 'points', 'segments', 'areas'];

let dbPromise = null;

function openDb(attempt = 0) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      if (attempt < 2) setTimeout(() => openDb(attempt + 1).then(resolve, reject), 300);
      else reject(req.error);
    };
  });
}

function db() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export const idbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
export const idbPut = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key));
export const idbDelete = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
export const idbKeys = (store) => tx(store, 'readonly', (s) => s.getAllKeys());
export const idbGetAll = (store) => tx(store, 'readonly', (s) => s.getAll());

// --- settings (localStorage) ------------------------------------------------

const SETTINGS_KEY = 'pegged.settings';

export const DEFAULT_SETTINGS = {
  lang: null, // null -> from navigator.language
  stabilityThreshold: 0.5, // m; 0.3 | 0.5 | 1.0
  vertexTolCm: 1, // parcel vertex matching tolerance, centimetres
  testMode: false,
  simulator: {
    enabled: false,
    trueE: 486456.14, // fixture point 14130
    trueN: 46481.96,
    biasM: 1.8,
    biasDeg: 40,
    noiseSigma: 2.5,
    reportedAcc: 4,
    rateHz: 1,
    ar1: 0.9,
  },
};

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / quota: settings just won't persist */
  }
}

export function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(safeGet(SETTINGS_KEY) ?? '{}');
  } catch {
    s = {};
  }
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    simulator: { ...DEFAULT_SETTINGS.simulator, ...(s.simulator ?? {}) },
  };
}

export function saveSettings(settings) {
  safeSet(SETTINGS_KEY, JSON.stringify(settings));
}

// --- device / session identity ---------------------------------------------

export function getDeviceId() {
  let id = safeGet('pegged.deviceId');
  if (!id) {
    id = crypto.randomUUID();
    safeSet('pegged.deviceId', id);
  }
  return id;
}

export const sessionId = crypto.randomUUID(); // regenerated on every (re)load

// --- foundPhysically flags (survive re-fetch of cadastre points) ------------

const FOUND_KEY = 'pegged.found';

export function loadFoundFlags() {
  try {
    return JSON.parse(safeGet(FOUND_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function setFoundFlag(eid, found) {
  const flags = loadFoundFlags();
  if (found) flags[String(eid)] = true;
  else delete flags[String(eid)];
  safeSet(FOUND_KEY, JSON.stringify(flags));
  return flags;
}

// --- parcel data persistence (for offline use) ------------------------------

export async function saveParcelData(parcel, points, segments) {
  const key = String(parcel.eid);
  await idbPut('parcels', key, parcel);
  await idbPut('points', key, points);
  await idbPut('segments', key, segments);
}

export async function loadParcelData(eid) {
  const key = String(eid);
  const parcel = await idbGet('parcels', key);
  if (!parcel) return null;
  return {
    parcel,
    points: (await idbGet('points', key)) ?? [],
    segments: (await idbGet('segments', key)) ?? [],
  };
}

export async function listStoredParcels() {
  return idbGetAll('parcels');
}

// --- prepared offline areas --------------------------------------------------

export async function saveArea(area) {
  await idbPut('areas', area.id, area);
}

export async function listAreas() {
  return idbGetAll('areas');
}

export async function deleteArea(id) {
  await idbDelete('areas', id);
}
