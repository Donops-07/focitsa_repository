/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Search Worker
   Runs entirely in a DedicatedWorkerGlobalScope.
   Uses vendored Fuse.js (no external CDN dependency) + IndexedDB hash cache.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// Load vendored Fuse.js locally (eliminates jsDelivr CDN SPOF)
try {
  importScripts('/assets/fuse.min.js?v=2026.2');
} catch (_) {
  importScripts('fuse.min.js?v=2026.2');
}

// ── IndexedDB Configuration ───────────────────────────────────────────────────

const IDB_DB_NAME    = 'focit_kb_v1';
const IDB_STORE_NAME = 'manifest_cache';
const IDB_VERSION    = 1;

// ── Fuse.js Configuration ─────────────────────────────────────────────────────

const FUSE_OPTIONS = {
  keys: [
    { name: 'courseCode',  weight: 0.35 },
    { name: 'aliases',     weight: 0.20 },
    { name: 'courseTitle', weight: 0.20 },
    { name: 'fileName',    weight: 0.15 },
    { name: 'tags',        weight: 0.05 },
    { name: 'year',        weight: 0.03 },
    { name: 'type',        weight: 0.02 },
  ],
  threshold:          0.35,
  includeScore:       true,
  useExtendedSearch:  true,
  ignoreLocation:     true,
  minMatchCharLength: 2,
};

// ── Shared Worker State ───────────────────────────────────────────────────────

/** @type {Fuse|null} */
let fuseIndex = null;

/** @type {Array} */
let manifestData = [];

/** @type {Promise<void>|null} Guard against duplicate concurrent INIT calls */
let initPromise = null;

// ── IndexedDB Helpers ─────────────────────────────────────────────────────────

/**
 * Open the IndexedDB database, creating the object store on first run.
 * @returns {Promise<IDBDatabase>}
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_DB_NAME, IDB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror   = (event) => reject(event.target.error);
  });
}

/**
 * Read a value from the object store by key.
 * @param {IDBDatabase} db
 * @param {string} key
 * @returns {Promise<any|null>}
 */
function dbGet(db, key) {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(IDB_STORE_NAME, 'readonly')
      .objectStore(IDB_STORE_NAME)
      .get(key);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror   = () => reject(request.error);
  });
}

/**
 * Write a value to the object store under the given key.
 * @param {IDBDatabase} db
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
function dbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction(IDB_STORE_NAME, 'readwrite')
      .objectStore(IDB_STORE_NAME)
      .put(value, key);

    request.onsuccess = () => resolve();
    request.onerror   = () => reject(request.error);
  });
}

/**
 * Delete all keys from the store except the current one.
 * @param {IDBDatabase} db
 * @param {string} currentKey
 * @returns {Promise<void>}
 */
function dbPurgeStale(db, currentKey) {
  return new Promise((resolve) => {
    try {
      const store   = db.transaction(IDB_STORE_NAME, 'readwrite').objectStore(IDB_STORE_NAME);
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) { resolve(); return; }
        if (cursor.key !== currentKey) cursor.delete();
        cursor.continue();
      };

      request.onerror = () => resolve();
    } catch (_) {
      resolve();
    }
  });
}

// ── Core Initialisation ───────────────────────────────────────────────────────

/**
 * Main init sequence with IDB lifecycle & quota resilience.
 */
async function runInit() {
  // Step 1 — Fetch version sidecar (tiny, always fresh)
  let currentHash = null;
  try {
    const versionRes = await fetch('/manifest.version.json', { cache: 'no-cache' });
    if (!versionRes.ok) throw new Error(`Version fetch failed: ${versionRes.status}`);
    const version = await versionRes.json();
    currentHash   = version && version.hash ? String(version.hash) : null;
  } catch (err) {
    console.warn('[Worker] Could not fetch version file, falling back to direct fetch:', err.message);
    await fetchAndIndexManifest();
    return;
  }

  if (!currentHash) {
    await fetchAndIndexManifest();
    return;
  }

  const cacheKey = `manifest_${currentHash}`;

  // Step 2 — Open IndexedDB (if available)
  let db = null;
  try {
    db = await openDatabase();
  } catch (err) {
    console.warn('[Worker] IndexedDB unavailable, falling back to direct fetch:', err.message);
    await fetchAndIndexManifest();
    return;
  }

  try {
    // Step 3 — Check cache
    let data = null;
    try {
      data = await dbGet(db, cacheKey);
    } catch (err) {
      console.warn('[Worker] IDB read failed, falling back to network:', err.message);
      data = null;
    }

    if (Array.isArray(data)) {
      buildIndex(data);
      return;
    }

    // Step 4 — Cache miss: fetch full manifest from root-relative path
    const res = await fetch('/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
    data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error('Manifest payload is not an array');
    }

    // Persist in IDB without aborting render on QuotaExceededError / private mode
    try {
      await dbPut(db, cacheKey, data);
      await dbPurgeStale(db, cacheKey);
    } catch (idbWriteErr) {
      console.warn('[Worker] IDB cache write skipped (serving live manifest):', idbWriteErr.message);
    }

    buildIndex(data);
  } catch (err) {
    postError(`Failed to load manifest: ${err.message}`);
  } finally {
    if (db) {
      try { db.close(); } catch (_) { }
    }
  }
}

function init() {
  if (fuseIndex && manifestData.length > 0) {
    self.postMessage({
      type:      'READY',
      resources: manifestData,
      count:     manifestData.length,
    });
    return Promise.resolve();
  }

  if (!initPromise) {
    initPromise = runInit().finally(() => {
      initPromise = null;
    });
  }
  return initPromise;
}

/**
 * Fallback: fetch manifest directly from root-relative /manifest.json without IDB caching.
 */
async function fetchAndIndexManifest() {
  try {
    const res  = await fetch('/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error('Manifest payload is not an array');
    }
    buildIndex(data);
  } catch (err) {
    postError(`Manifest unavailable: ${err.message}`);
  }
}

/**
 * Construct the Fuse.js in-memory search index off the main thread.
 * @param {Array} data
 */
function buildIndex(data) {
  manifestData = data;
  fuseIndex    = new Fuse(data, FUSE_OPTIONS);

  self.postMessage({
    type:      'READY',
    resources: data,
    count:     data.length,
  });
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Execute a fuzzy search and post results tagged with monotonic requestId.
 * @param {string} query
 * @param {number} requestId
 */
function search(query, requestId) {
  if (!fuseIndex) return;

  const trimmed = String(query || '').trim();
  const results = trimmed ? fuseIndex.search(trimmed, { limit: 200 }) : [];

  self.postMessage({
    type:      'RESULTS',
    results,
    query:     trimmed,
    requestId,
  });
}

// ── Error Helper ──────────────────────────────────────────────────────────────

function postError(message) {
  self.postMessage({ type: 'ERROR', message });
}

// ── Message Router ────────────────────────────────────────────────────────────

self.onmessage = function (event) {
  const payload = event.data || {};

  switch (payload.type) {
    case 'INIT':
      init().catch((err) => postError(err.message));
      break;

    case 'SEARCH':
      search(payload.query, payload.requestId);
      break;

    default:
      console.warn('[Worker] Unknown message type:', payload.type);
  }
};
