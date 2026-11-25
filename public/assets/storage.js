/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Resilient Client Storage & Offline Cache
   - ProgressStore: localStorage with try/catch + memory fallback + visibility flush
   - ReaderPrefsStore: typography, theme & zoom preferences
   - OfflineBlobCache: strictly OPT-IN dual-store IndexedDB v2 (150 MB LRU + Quota retry)
   ═══════════════════════════════════════════════════════════════════════════ */

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FocitStorage = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROGRESS_KEY = 'focit_reading_progress_v1';
  const PREFS_KEY = 'focit_reader_prefs_v1';
  const OFFLINE_DB_NAME = 'focit_offline_blobs_v1';
  const OFFLINE_BLOB_STORE = 'blobs';
  const OFFLINE_META_STORE = 'meta';
  const OFFLINE_DB_VERSION = 2;

  const MAX_OFFLINE_CACHE_BYTES = 150 * 1024 * 1024; // 150 MB LRU cap
  const CHUNK_SIZE = 131072; // 128 KB aligned slices
  const OFFLINE_CONCURRENCY = 3;
  const MAX_FULL_MODE_BYTES = 4 * 1024 * 1024; // 4 MB limit for mode=full

  const VALID_THEMES = new Set(['light', 'sepia', 'dark']);
  const VALID_FONT_FAMILIES = new Set(['sans', 'serif']);

  function computeVersionTag(resourceOrUploadedAt, fallback = '1') {
    const raw = typeof resourceOrUploadedAt === 'string'
      ? resourceOrUploadedAt
      : resourceOrUploadedAt?.uploadedAt;
    const ts = Date.parse(raw || '');
    return Number.isFinite(ts) ? String(ts) : String(fallback || '1');
  }

  // ── Safe Storage Wrapper ────────────────────────────────────────────────────

  const memoryFallback = new Map();
  let customStorageBackend = null;

  function getStorageBackend() {
    if (customStorageBackend) return customStorageBackend;
    try {
      if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
        return globalThis.localStorage;
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  function safeGetItem(key) {
    const backend = getStorageBackend();
    if (backend) {
      try {
        return backend.getItem(key);
      } catch (_) {
        // Fall through to memory fallback
      }
    }
    return memoryFallback.has(key) ? memoryFallback.get(key) : null;
  }

  function safeSetItem(key, value) {
    memoryFallback.set(key, value);
    const backend = getStorageBackend();
    if (backend) {
      try {
        backend.setItem(key, value);
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  function safeJsonParse(raw, fallback) {
    if (!raw || typeof raw !== 'string') return fallback;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
      return fallback;
    }
  }

  // ── ProgressStore ───────────────────────────────────────────────────────────

  function clampNumber(val, min, max, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeProgressEntry(entry) {
    if (!entry || typeof entry.resourceId !== 'string' || !entry.resourceId) {
      return null;
    }
    const unit = entry.unit === 'page' || entry.unit === 'percent' ? entry.unit : 'status';
    const total = Number.isFinite(Number(entry.total)) && Number(entry.total) > 0
      ? Number(entry.total)
      : (unit === 'percent' ? 100 : 1);

    let current = Number.isFinite(Number(entry.current)) && Number(entry.current) >= 0
      ? Number(entry.current)
      : 0;
    if (unit === 'page') {
      current = Math.max(1, Math.min(total, Math.round(current || 1)));
    } else if (unit === 'percent') {
      current = clampNumber(current, 0, 100, 0);
    }

    let percent;
    if (Number.isFinite(Number(entry.percent))) {
      percent = Math.round(clampNumber(entry.percent, 0, 100, 0));
    } else if (unit === 'page') {
      percent = Math.round((current / Math.max(1, total)) * 100);
    } else if (unit === 'percent') {
      percent = Math.round(current);
    } else {
      percent = entry.completed ? 100 : 0;
    }

    const explicitCompleted = typeof entry.completed === 'boolean' ? entry.completed : null;
    const completed = explicitCompleted !== null
      ? (explicitCompleted || percent >= 95)
      : percent >= 95;

    return {
      resourceId: String(entry.resourceId),
      fileId: String(entry.fileId || ''),
      courseCode: String(entry.courseCode || 'GENERAL'),
      title: String(entry.title || 'Untitled Document'),
      fileExt: String(entry.fileExt || 'PDF').toUpperCase(),
      unit,
      current,
      total,
      percent,
      completed,
      updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : Date.now(),
    };
  }

  let pendingProgressEntry = null;
  let pendingProgressTimer = null;

  const ProgressStore = {
    getAllMap() {
      const parsed = safeJsonParse(safeGetItem(PROGRESS_KEY), {});
      const out = {};
      for (const [key, val] of Object.entries(parsed)) {
        const normalized = normalizeProgressEntry({ ...val, resourceId: val?.resourceId || key });
        if (normalized) out[key] = normalized;
      }
      return out;
    },

    get(resourceId) {
      if (!resourceId) return null;
      const map = this.getAllMap();
      return map[resourceId] || null;
    },

    getRecent(limit = 4) {
      const items = Object.values(this.getAllMap());
      items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return items.slice(0, Math.max(0, limit));
    },

    save(entry) {
      const normalized = normalizeProgressEntry({
        ...entry,
        updatedAt: Date.now(),
      });
      if (!normalized) return null;

      const map = this.getAllMap();
      map[normalized.resourceId] = normalized;

      const entries = Object.values(map);
      if (entries.length > 200) {
        entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        const trimmed = {};
        for (const item of entries.slice(0, 200)) {
          trimmed[item.resourceId] = item;
        }
        safeSetItem(PROGRESS_KEY, JSON.stringify(trimmed));
      } else {
        safeSetItem(PROGRESS_KEY, JSON.stringify(map));
      }
      return normalized;
    },

    scheduleSave(entry, delayMs = 400) {
      const normalized = normalizeProgressEntry({ ...entry, updatedAt: Date.now() });
      if (!normalized) return;
      pendingProgressEntry = normalized;
      if (pendingProgressTimer) {
        clearTimeout(pendingProgressTimer);
      }
      pendingProgressTimer = setTimeout(() => {
        this.flushPending();
      }, delayMs);
    },

    flushPending() {
      if (pendingProgressTimer) {
        clearTimeout(pendingProgressTimer);
        pendingProgressTimer = null;
      }
      if (!pendingProgressEntry) return null;
      const toSave = pendingProgressEntry;
      pendingProgressEntry = null;
      return this.save(toSave);
    },

    markCompleted(resourceId, completed, meta = {}) {
      const existing = this.get(resourceId) || {};
      const nextCompleted = Boolean(completed);
      return this.save({
        ...existing,
        ...meta,
        resourceId,
        unit: existing.unit || meta.unit || 'status',
        current: existing.current ?? meta.current ?? (nextCompleted ? 1 : 0),
        total: existing.total ?? meta.total ?? 1,
        percent: nextCompleted ? 100 : (existing.percent >= 95 ? 0 : (existing.percent || 0)),
        completed: nextCompleted,
      });
    },

    _setStorageForTest(mockStorage) {
      customStorageBackend = mockStorage || null;
      memoryFallback.clear();
      pendingProgressEntry = null;
      if (pendingProgressTimer) {
        clearTimeout(pendingProgressTimer);
        pendingProgressTimer = null;
      }
    },
  };

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        ProgressStore.flushPending();
      }
    });
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => {
      ProgressStore.flushPending();
    });
  }

  // ── ReaderPrefsStore ────────────────────────────────────────────────────────

  const DEFAULT_PREFS = {
    theme: 'light',
    fontSize: 16,
    fontFamily: 'sans',
    zoomMode: 'fit-width',
    wordWrap: true,
  };

  function normalizePrefs(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const theme = VALID_THEMES.has(src.theme) ? src.theme : DEFAULT_PREFS.theme;
    const fontSize = Math.round(clampNumber(src.fontSize, 13, 24, DEFAULT_PREFS.fontSize));
    const fontFamily = VALID_FONT_FAMILIES.has(src.fontFamily) ? src.fontFamily : DEFAULT_PREFS.fontFamily;
    const zoomMode = src.zoomMode === 'fit-width'
      ? 'fit-width'
      : clampNumber(src.zoomMode, 0.75, 2.0, DEFAULT_PREFS.zoomMode);
    const wordWrap = typeof src.wordWrap === 'boolean' ? src.wordWrap : DEFAULT_PREFS.wordWrap;
    return { theme, fontSize, fontFamily, zoomMode, wordWrap };
  }

  const ReaderPrefsStore = {
    get() {
      const parsed = safeJsonParse(safeGetItem(PREFS_KEY), DEFAULT_PREFS);
      return normalizePrefs(parsed);
    },

    update(patch) {
      const current = this.get();
      const next = normalizePrefs({ ...current, ...(patch || {}) });
      safeSetItem(PREFS_KEY, JSON.stringify(next));
      return next;
    },
  };

  // ── OfflineBlobCache (Dual-Store IDB v2, Strictly OPT-IN) ───────────────────

  class StorageQuotaError extends Error {
    constructor(message) {
      super(message || 'Device offline storage is full. Remove saved documents and try again.');
      this.name = 'StorageQuotaError';
    }
  }

  function isQuotaExceededError(err) {
    if (!err) return false;
    return (
      err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err.code === 22 ||
      err.code === 1014
    );
  }

  function buildMetaOnly(record) {
    return {
      fileId: record.fileId,
      resourceId: record.resourceId || '',
      fileName: record.fileName || '',
      mimeType: record.mimeType || 'application/octet-stream',
      size: Number(record.size || record.blob?.size || 0),
      savedAt: Number(record.savedAt || Date.now()),
      lastAccessed: Number(record.lastAccessed || Date.now()),
    };
  }

  function openOfflineDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is unavailable in this browser.'));
        return;
      }
      const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        const tx = event.target.transaction;

        if (!db.objectStoreNames.contains(OFFLINE_BLOB_STORE)) {
          db.createObjectStore(OFFLINE_BLOB_STORE, { keyPath: 'fileId' });
        }
        if (!db.objectStoreNames.contains(OFFLINE_META_STORE)) {
          const metaStore = db.createObjectStore(OFFLINE_META_STORE, { keyPath: 'fileId' });
          metaStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
        }

        // Safe v1 -> v2 metadata migration when upgrading existing browsers
        if (
          event.oldVersion > 0 &&
          event.oldVersion < 2 &&
          tx &&
          db.objectStoreNames.contains(OFFLINE_BLOB_STORE) &&
          db.objectStoreNames.contains(OFFLINE_META_STORE)
        ) {
          try {
            const blobStore = tx.objectStore(OFFLINE_BLOB_STORE);
            const metaStore = tx.objectStore(OFFLINE_META_STORE);
            const cursorReq = blobStore.openCursor();
            cursorReq.onsuccess = (ce) => {
              const cursor = ce.target.result;
              if (!cursor) return;
              const val = cursor.value;
              if (val && val.fileId) {
                metaStore.put(buildMetaOnly(val));
                if (val.blob !== undefined) {
                  cursor.update({ fileId: val.fileId, blob: val.blob });
                }
              }
              cursor.continue();
            };
          } catch (_) { }
        }
      };
      req.onsuccess = (event) => resolve(event.target.result);
      req.onerror = (event) => reject(event.target.error || new Error('Failed to open offline database.'));
    });
  }

  function createIdbAdapter(db) {
    return {
      listMeta() {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(OFFLINE_META_STORE, 'readonly');
          const store = tx.objectStore(OFFLINE_META_STORE);
          const req = store.getAll();
          req.onsuccess = () => {
            const rows = Array.isArray(req.result) ? req.result : [];
            resolve(
              rows.map((r) => ({
                fileId: r.fileId,
                size: Number(r.size || 0),
                lastAccessed: Number(r.lastAccessed || 0),
              }))
            );
          };
          req.onerror = () => reject(req.error);
        });
      },
      listIds() {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(OFFLINE_META_STORE, 'readonly');
          const req = tx.objectStore(OFFLINE_META_STORE).getAllKeys();
          req.onsuccess = () => resolve(new Set(Array.isArray(req.result) ? req.result : []));
          req.onerror = () => reject(req.error);
        });
      },
      has(fileId) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(OFFLINE_META_STORE, 'readonly');
          const req = tx.objectStore(OFFLINE_META_STORE).count(fileId);
          req.onsuccess = () => resolve(Number(req.result) > 0);
          req.onerror = () => reject(req.error);
        });
      },
      put(record) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction([OFFLINE_META_STORE, OFFLINE_BLOB_STORE], 'readwrite');
          tx.objectStore(OFFLINE_META_STORE).put(buildMetaOnly(record));
          tx.objectStore(OFFLINE_BLOB_STORE).put({ fileId: record.fileId, blob: record.blob });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed.'));
          tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted.'));
        });
      },
      touchMeta(fileId, ts) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction(OFFLINE_META_STORE, 'readwrite');
          const store = tx.objectStore(OFFLINE_META_STORE);
          const getReq = store.get(fileId);
          getReq.onsuccess = () => {
            if (getReq.result) {
              store.put({ ...getReq.result, lastAccessed: ts });
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || getReq.error);
        });
      },
      remove(fileId) {
        return new Promise((resolve, reject) => {
          const tx = db.transaction([OFFLINE_META_STORE, OFFLINE_BLOB_STORE], 'readwrite');
          tx.objectStore(OFFLINE_META_STORE).delete(fileId);
          tx.objectStore(OFFLINE_BLOB_STORE).delete(fileId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed.'));
        });
      },
    };
  }

  async function writeRecordWithQuotaRecovery(adapter, record, maxBytes = MAX_OFFLINE_CACHE_BYTES) {
    const incomingSize = Number(record.size || record.blob?.size || 0);
    if (incomingSize > maxBytes) {
      throw new StorageQuotaError(
        `File (${(incomingSize / 1048576).toFixed(1)} MB) exceeds the ${Math.round(maxBytes / 1048576)} MB offline cache cap.`
      );
    }

    const existing = await adapter.listMeta();
    const otherRecords = existing
      .filter((r) => r.fileId !== record.fileId)
      .sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));

    let totalBytes = otherRecords.reduce((sum, r) => sum + (Number(r.size) || 0), 0);
    let proactiveEvictions = 0;
    while (totalBytes + incomingSize > maxBytes && otherRecords.length > 0) {
      const oldest = otherRecords.shift();
      await adapter.remove(oldest.fileId);
      totalBytes -= Number(oldest.size) || 0;
      proactiveEvictions += 1;
    }

    try {
      await adapter.put(record);
      return { evictedCount: proactiveEvictions, retried: false };
    } catch (err) {
      if (!isQuotaExceededError(err)) throw err;

      // Aggressive LRU eviction on device QuotaExceededError, then retry ONCE
      let freed = 0;
      let evictedCount = 0;
      while (otherRecords.length > 0 && (freed < incomingSize || evictedCount === 0)) {
        const oldest = otherRecords.shift();
        await adapter.remove(oldest.fileId);
        freed += Number(oldest.size) || 0;
        evictedCount += 1;
      }

      try {
        await adapter.put(record);
        return { evictedCount, retried: true };
      } catch (retryErr) {
        if (isQuotaExceededError(retryErr)) {
          throw new StorageQuotaError(
            'Not enough free storage on this device to save this document offline.'
          );
        }
        throw retryErr;
      }
    }
  }

  async function parseChunkErrorResponse(res) {
    try {
      const ct = res.headers?.get?.('content-type') || '';
      if (ct.includes('application/json')) {
        const payload = await res.json();
        return payload?.message || payload?.error || `HTTP ${res.status}`;
      }
    } catch (_) { }
    return `Request failed with HTTP ${res.status}`;
  }

  async function assembleChunksWithConcurrency({
    fileId,
    fileSize,
    versionTag = '1',
    mimeType = 'application/pdf',
    chunkSize = CHUNK_SIZE,
    concurrency = OFFLINE_CONCURRENCY,
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    signal,
    onProgress,
  }) {
    if (!fetchImpl) {
      throw new Error('Fetch API is unavailable.');
    }
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      throw new Error('Cannot assemble chunked offline file without a valid fileSize.');
    }

    const slices = [];
    for (let start = 0, index = 0; start < fileSize; start += chunkSize, index += 1) {
      const end = Math.min(start + chunkSize - 1, fileSize - 1);
      slices.push({ index, start, end });
    }

    const poolAbort = new AbortController();
    const onExternalAbort = () => poolAbort.abort();
    if (signal) {
      if (signal.aborted) {
        poolAbort.abort();
      } else if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const buffers = new Array(slices.length);
    let cursor = 0;
    let loadedBytes = 0;
    let failed = false;

    async function workerLoop() {
      try {
        while (true) {
          if (failed || poolAbort.signal.aborted) {
            if (signal?.aborted) {
              throw new DOMException('Aborted', 'AbortError');
            }
            return;
          }
          const myIdx = cursor;
          cursor += 1;
          if (myIdx >= slices.length) return;

          const slice = slices[myIdx];
          const url = `/api/chunk?id=${encodeURIComponent(fileId)}&start=${slice.start}&end=${slice.end}&v=${encodeURIComponent(versionTag)}`;
          const res = await fetchImpl(url, { signal: poolAbort.signal });
          if (!res.ok) {
            throw new Error(await parseChunkErrorResponse(res));
          }
          const ab = await res.arrayBuffer();
          const bytes = new Uint8Array(ab);
          buffers[slice.index] = bytes;
          loadedBytes += bytes.byteLength;

          if (!failed && !poolAbort.signal.aborted && typeof onProgress === 'function') {
            onProgress({
              loaded: loadedBytes,
              total: fileSize,
              percent: Math.min(100, Math.round((loadedBytes / fileSize) * 100)),
            });
          }
        }
      } catch (err) {
        failed = true;
        poolAbort.abort();
        throw err;
      }
    }

    try {
      const workerCount = Math.min(Math.max(1, concurrency), slices.length);
      await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
      return new Blob(buffers, { type: mimeType || 'application/pdf' });
    } finally {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  async function fetchFullModeBlob({
    fileId,
    fileSize,
    versionTag = '1',
    mimeType = 'application/octet-stream',
    fetchImpl = typeof fetch === 'function' ? fetch : null,
    signal,
    onProgress,
  }) {
    if (!fetchImpl) {
      throw new Error('Fetch API is unavailable.');
    }
    const url = `/api/chunk?id=${encodeURIComponent(fileId)}&mode=full&v=${encodeURIComponent(versionTag)}`;
    const res = await fetchImpl(url, { signal });
    if (!res.ok) {
      throw new Error(await parseChunkErrorResponse(res));
    }

    const total = Number(res.headers?.get?.('content-length')) || fileSize || 0;
    if (!res.body || typeof res.body.getReader !== 'function') {
      const ab = await res.arrayBuffer();
      if (typeof onProgress === 'function') {
        onProgress({ loaded: ab.byteLength, total: ab.byteLength, percent: 100 });
      }
      return new Blob([ab], { type: res.headers?.get?.('content-type') || mimeType });
    }

    const reader = res.body.getReader();
    const parts = [];
    let loaded = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        parts.push(value);
        loaded += value.byteLength;
        if (typeof onProgress === 'function') {
          onProgress({
            loaded,
            total: total || loaded,
            percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : null,
          });
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_) { }
    }

    return new Blob(parts, { type: res.headers?.get?.('content-type') || mimeType });
  }

  const OfflineBlobCache = {
    async listIds() {
      let db;
      try {
        db = await openOfflineDb();
        return await createIdbAdapter(db).listIds();
      } catch (_) {
        return new Set();
      } finally {
        if (db) try { db.close(); } catch (_) { }
      }
    },

    async getUsageBytes() {
      let db;
      try {
        db = await openOfflineDb();
        const meta = await createIdbAdapter(db).listMeta();
        return meta.reduce((sum, m) => sum + (Number(m.size) || 0), 0);
      } catch (_) {
        return 0;
      } finally {
        if (db) try { db.close(); } catch (_) { }
      }
    },

    async has(fileId) {
      if (!fileId) return false;
      let db;
      try {
        db = await openOfflineDb();
        return await createIdbAdapter(db).has(fileId);
      } catch (_) {
        return false;
      } finally {
        if (db) try { db.close(); } catch (_) { }
      }
    },

    async get(fileId) {
      if (!fileId) return null;
      let db;
      try {
        db = await openOfflineDb();
        const [blobRow, metaRow] = await Promise.all([
          new Promise((resolve, reject) => {
            const tx = db.transaction(OFFLINE_BLOB_STORE, 'readonly');
            const req = tx.objectStore(OFFLINE_BLOB_STORE).get(fileId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
          }),
          new Promise((resolve, reject) => {
            const tx = db.transaction(OFFLINE_META_STORE, 'readonly');
            const req = tx.objectStore(OFFLINE_META_STORE).get(fileId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
          }),
        ]);
        if (!blobRow || !blobRow.blob) return null;

        await createIdbAdapter(db).touchMeta(fileId, Date.now()).catch(() => {});
        return {
          ...(metaRow || {}),
          fileId,
          blob: blobRow.blob,
        };
      } catch (_) {
        return null;
      } finally {
        if (db) try { db.close(); } catch (_) { }
      }
    },

    async remove(fileId) {
      if (!fileId) return;
      let db;
      try {
        db = await openOfflineDb();
        await createIdbAdapter(db).remove(fileId);
      } finally {
        if (db) try { db.close(); } catch (_) { }
      }
    },

    async putWithQuotaRecovery(record) {
      let db;
      try {
        db = await openOfflineDb();
        return await writeRecordWithQuotaRecovery(createIdbAdapter(db), record, MAX_OFFLINE_CACHE_BYTES);
      } finally {
        if (db) try { db.close(); } catch (_) { }
      }
    },

    async downloadAndSave({ resource, versionTag, signal, onProgress }) {
      if (!resource || !resource.fileId) {
        throw new Error('Invalid resource metadata.');
      }

      const resolvedVersion = versionTag || computeVersionTag(resource);
      const isWorkspaceDoc = String(resource.mimeType || '').startsWith('application/vnd.google-apps.');
      const fileSize = Number(resource.fileSize);
      const useChunkedAssembly =
        !isWorkspaceDoc &&
        Number.isSafeInteger(fileSize) &&
        fileSize > 0 &&
        (String(resource.fileExt || '').toUpperCase() === 'PDF' || fileSize > MAX_FULL_MODE_BYTES);

      const blob = useChunkedAssembly
        ? await assembleChunksWithConcurrency({
            fileId: resource.fileId,
            fileSize,
            versionTag: resolvedVersion,
            mimeType: resource.mimeType || 'application/pdf',
            chunkSize: CHUNK_SIZE,
            concurrency: OFFLINE_CONCURRENCY,
            signal,
            onProgress,
          })
        : await fetchFullModeBlob({
            fileId: resource.fileId,
            fileSize: Number.isSafeInteger(fileSize) ? fileSize : 0,
            versionTag: resolvedVersion,
            mimeType: isWorkspaceDoc ? 'application/pdf' : (resource.mimeType || 'application/octet-stream'),
            signal,
            onProgress,
          });

      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const record = {
        fileId: resource.fileId,
        resourceId: resource.id,
        fileName: resource.fileName || '',
        mimeType: blob.type || resource.mimeType || 'application/octet-stream',
        size: blob.size,
        blob,
        savedAt: Date.now(),
        lastAccessed: Date.now(),
      };

      await this.putWithQuotaRecovery(record);
      return record;
    },
  };

  return {
    OFFLINE_DB_VERSION,
    OFFLINE_BLOB_STORE,
    OFFLINE_META_STORE,
    MAX_OFFLINE_CACHE_BYTES,
    CHUNK_SIZE,
    OFFLINE_CONCURRENCY,
    MAX_FULL_MODE_BYTES,
    computeVersionTag,
    ProgressStore,
    ReaderPrefsStore,
    OfflineBlobCache,
    StorageQuotaError,
    _internal: {
      normalizeProgressEntry,
      isQuotaExceededError,
      assembleChunksWithConcurrency,
      writeRecordWithQuotaRecovery,
      fetchFullModeBlob,
    },
  };
});
