/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Search Worker
   Runs entirely in a DedicatedWorkerGlobalScope.
   No access to: window, document, localStorage, or the DOM.
   Available APIs: fetch, indexedDB, importScripts, postMessage.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// Load Fuse.js into the worker scope (CDN — vendored copy recommended for production)
importScripts('https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js');

// ── IndexedDB Configuration ───────────────────────────────────────────────────

const IDB_DB_NAME    = 'focit_kb_v1';
const IDB_STORE_NAME = 'manifest_cache';
const IDB_VERSION    = 1;

// ── Fuse.js Configuration ─────────────────────────────────────────────────────

const FUSE_OPTIONS = {
  // Fields to search, with relevance weights
  keys: [
    { name: 'courseCode',  weight: 0.40 }, // Highest signal — "COS 201"
    { name: 'courseTitle', weight: 0.25 }, // "Discrete Structures"
    { name: 'tags',        weight: 0.20 }, // ["discrete", "logic", "graphs"]
    { name: 'year',        weight: 0.10 }, // 2024
    { name: 'type',        weight: 0.05 }, // "Past Question"
  ],
  threshold:        0.35,   // Fuzzy tolerance — catches "COS201" vs "COS 201", typos
  includeScore:     true,
  useExtendedSearch:true,   // Enables exact-match prefix with `=` operator
  ignoreLocation:   true,   // Don't penalise matches far from string start
  minMatchCharLength: 2,
};

// ── Shared State ──────────────────────────────────────────────────────────────

/** @type {Fuse|null} */
let fuseIndex = null;

/** @type {Array} Full manifest array (also held for READY postMessage) */
let manifestData = [];

// ── IndexedDB Helpers (Promise-wrapped IDB request model) ─────────────────────

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
 * Prevents unbounded storage growth across manifest versions.
 * @param {IDBDatabase} db
 * @param {string} currentKey
 * @returns {Promise<void>}
 */
function dbPurgeStale(db, currentKey) {
  return new Promise((resolve) => {
    const store   = db.transaction(IDB_STORE_NAME, 'readwrite').objectStore(IDB_STORE_NAME);
    const request = store.openCursor();

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) { resolve(); return; }
      if (cursor.key !== currentKey) cursor.delete();
      cursor.continue();
    };

    // Non-fatal — stale entries will be cleaned on next successful run
    request.onerror = () => resolve();
  });
}

// ── Core Initialisation ───────────────────────────────────────────────────────

/**
 * Main init sequence:
 * 1. Fetch manifest.version.json — always fresh (~80 bytes, no-cache)
 * 2. Open IndexedDB
 * 3. Check cache for the current hash
 * 4. On cache hit → use stored data (zero network cost for manifest)
 * 5. On cache miss → fetch manifest.json, store in IDB
 * 6. Build Fuse.js index (entirely off the main thread)
 * 7. Post READY to main thread
 */
async function init() {
  // Step 1 — Fetch version sidecar (tiny, always fresh)
  let currentHash;
  try {
    const versionRes = await fetch('/manifest.version.json', { cache: 'no-cache' });
    if (!versionRes.ok) throw new Error(`Version fetch failed: ${versionRes.status}`);
    const version = await versionRes.json();
    currentHash   = version.hash;
  } catch (err) {
    // If version file is unavailable, fall back to direct fetch without caching
    console.warn('[Worker] Could not fetch version file, falling back to direct fetch:', err.message);
    await fetchAndIndexManifest();
    return;
  }

  const cacheKey = `manifest_${currentHash}`;

  // Step 2 — Open IndexedDB
  let db;
  try {
    db = await openDatabase();
  } catch (err) {
    // IndexedDB unavailable (private browsing on some browsers, quota exceeded, etc.)
    console.warn('[Worker] IndexedDB unavailable, falling back to direct fetch:', err.message);
    await fetchAndIndexManifest();
    return;
  }

  // Step 3 — Check cache
  let data;
  try {
    data = await dbGet(db, cacheKey);
  } catch (err) {
    console.warn('[Worker] IDB read failed, falling back to fetch:', err.message);
    data = null;
  }

  if (data) {
    // ── Cache HIT ──────────────────────────────────────────────────────────────
    // IDB returns a native JS array via structured clone — no JSON.parse needed.
    buildIndex(data);
    return;
  }

  // ── Cache MISS — fetch the full manifest ──────────────────────────────────
  try {
    const res = await fetch('/manifest.json');
    if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
    data = await res.json();

    // Store in IDB (structured clone handles serialisation internally)
    await dbPut(db, cacheKey, data);

    // Purge stale manifest versions asynchronously (non-blocking)
    dbPurgeStale(db, cacheKey).catch(() => {});

  } catch (err) {
    postError(`Failed to load manifest: ${err.message}`);
    return;
  }

  buildIndex(data);
}

/**
 * Fallback: fetch manifest directly without any caching.
 * Used when IndexedDB or the version file is unavailable.
 */
async function fetchAndIndexManifest() {
  try {
    const res  = await fetch('manifest.json');
    if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
    const data = await res.json();
    buildIndex(data);
  } catch (err) {
    postError(`Manifest unavailable: ${err.message}`);
  }
}

/**
 * Construct the Fuse.js in-memory search index.
 * This is the CPU-intensive step — running here in the Worker
 * keeps the main UI thread completely unblocked.
 * @param {Array} data — parsed manifest array
 */
function buildIndex(data) {
  manifestData = data;
  fuseIndex    = new Fuse(data, FUSE_OPTIONS);

  self.postMessage({
    type:      'READY',
    resources: data,  // send all resources to main thread for filter logic
    count:     data.length,
  });
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Execute a fuzzy search and post results to the main thread.
 * @param {string} query
 */
function search(query) {
  if (!fuseIndex) return;

  const results = fuseIndex.search(query, { limit: 100 });

  self.postMessage({
    type:    'RESULTS',
    results, // Array of { item, score, refIndex }
    query,
  });
}

// ── Error Helper ──────────────────────────────────────────────────────────────

function postError(message) {
  self.postMessage({ type: 'ERROR', message });
}

// ── Message Router ────────────────────────────────────────────────────────────

self.onmessage = function (event) {
  const { type } = event.data;

  switch (type) {
    case 'INIT':
      init().catch((err) => postError(err.message));
      break;

    case 'SEARCH':
      search(event.data.query);
      break;

    default:
      console.warn('[Worker] Unknown message type:', type);
  }
};
