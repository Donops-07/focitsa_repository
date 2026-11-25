/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Format-Aware Mobile Document Reader Engine
   - AlignedBucketFetcher + PDFDataRangeTransport (128 KB immutable chunks)
   - Windowed PDF.js virtualized canvas renderer (current +- 1, GPU cleanup)
   - Reflowable DOCX renderer (Mammoth.js + DOMPurify + link/image hardening)
   - UTF-8 Text/Code renderer & Clean Degraded Slide Card (Option 2B)
   ═══════════════════════════════════════════════════════════════════════════ */

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root.FocitStorage || require('./storage.js'));
  } else {
    root.FocitReader = factory(root.FocitStorage);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (FocitStorage) {
  'use strict';

  const CHUNK_SIZE = 131072; // 128 KB aligned CDN slices
  const MAX_DOCX_BYTES = 5 * 1024 * 1024;
  const MAX_TEXT_BYTES = 2 * 1024 * 1024;
  const VENDOR_LOAD_TIMEOUT_MS = 15000;
  const VENDOR_CACHE_BUST = '2026.4';
  const SAFE_DRIVE_ID_RE = /^[a-zA-Z0-9_-]{10,64}$/;
  const SAFE_DRIVE_URL_RE = /^https:\/\/(drive|docs)\.google\.com\//i;

  const VENDOR_PATHS = {
    pdf: `assets/vendor/pdf.min.js?v=${VENDOR_CACHE_BUST}`,
    pdfWorker: `assets/vendor/pdf.worker.min.js?v=${VENDOR_CACHE_BUST}`,
    mammoth: `assets/vendor/mammoth.browser.min.js?v=${VENDOR_CACHE_BUST}`,
    dompurify: `assets/vendor/purify.min.js?v=${VENDOR_CACHE_BUST}`,
  };

  const DOC_SANITIZE_CONFIG = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button'],
    FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'onmouseover', 'onfocus'],
  };

  // ── Vendor Script Single-Flight Loader (Captive-Portal & Timeout Safe) ──────

  const scriptLoadCache = new Map();

  function invalidateVendorScript(src) {
    scriptLoadCache.delete(src);
    if (typeof document !== 'undefined') {
      document.querySelectorAll(`script[data-vendor-src="${src}"]`).forEach((el) => el.remove());
    }
  }

  function loadVendorScript(src, timeoutMs = VENDOR_LOAD_TIMEOUT_MS) {
    if (scriptLoadCache.has(src)) {
      return scriptLoadCache.get(src);
    }
    const promise = new Promise((resolve, reject) => {
      if (typeof document === 'undefined') {
        scriptLoadCache.delete(src);
        reject(new Error('Document unavailable for vendor script loading.'));
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.vendorSrc = src;

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        invalidateVendorScript(src);
        reject(new Error(`Timed out loading reader module: ${src}`));
      }, timeoutMs);

      script.onload = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      script.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        invalidateVendorScript(src);
        reject(new Error(`Failed to load reader module: ${src}`));
      };

      document.head.appendChild(script);
    });

    scriptLoadCache.set(src, promise);
    return promise;
  }

  async function ensurePdfJs() {
    if (!globalThis.pdfjsLib) {
      await loadVendorScript(VENDOR_PATHS.pdf);
    }
    if (!globalThis.pdfjsLib) {
      invalidateVendorScript(VENDOR_PATHS.pdf);
      throw new Error('PDF reader failed to initialize. Check your connection and retry.');
    }
    globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = VENDOR_PATHS.pdfWorker;
    return globalThis.pdfjsLib;
  }

  async function ensureDocxLibs() {
    const tasks = [];
    if (!globalThis.mammoth) tasks.push(loadVendorScript(VENDOR_PATHS.mammoth));
    if (!globalThis.DOMPurify) tasks.push(loadVendorScript(VENDOR_PATHS.dompurify));
    if (tasks.length > 0) await Promise.all(tasks);

    if (!globalThis.mammoth) invalidateVendorScript(VENDOR_PATHS.mammoth);
    if (!globalThis.DOMPurify) invalidateVendorScript(VENDOR_PATHS.dompurify);

    if (!globalThis.mammoth || !globalThis.DOMPurify) {
      throw new Error('DOCX reader failed to initialize. Check your connection and retry.');
    }
    return { mammoth: globalThis.mammoth, DOMPurify: globalThis.DOMPurify };
  }

  // ── Security & Formatting Helpers ───────────────────────────────────────────

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
  }

  function getSafeDownloadUrl(resource) {
    const candidate = String(resource?.downloadUrl || '').trim();
    if (SAFE_DRIVE_URL_RE.test(candidate)) {
      return candidate;
    }
    const fileId = String(resource?.fileId || '').trim();
    if (SAFE_DRIVE_ID_RE.test(fileId)) {
      return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
    }
    return '#';
  }

  function getSafePreviewUrl(resource) {
    const candidate = String(resource?.previewUrl || '').trim();
    if (SAFE_DRIVE_URL_RE.test(candidate)) {
      return candidate;
    }
    const fileId = String(resource?.fileId || '').trim();
    if (SAFE_DRIVE_ID_RE.test(fileId)) {
      return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
    }
    return '#';
  }

  function sanitizeDocxHtml(rawHtml, purifier = globalThis.DOMPurify) {
    if (!purifier || typeof purifier.sanitize !== 'function') {
      throw new Error('DOMPurify sanitizer is unavailable.');
    }
    return purifier.sanitize(String(rawHtml || ''), DOC_SANITIZE_CONFIG);
  }

  function hardenDocxArticleDom(articleEl) {
    if (!articleEl || typeof articleEl.querySelectorAll !== 'function') return;

    articleEl.querySelectorAll('a').forEach((a) => {
      const href = String(a.getAttribute('href') || '').trim();
      if (/^(https?:\/\/|mailto:|#)/i.test(href)) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      } else {
        a.removeAttribute('href');
      }
    });

    articleEl.querySelectorAll('img').forEach((img) => {
      const src = String(img.getAttribute('src') || '').trim();
      if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(src)) {
        img.remove();
      }
    });
  }

  class ReaderHttpError extends Error {
    constructor(message, { status = 500, code = 'READER_HTTP_ERROR', retryable = true } = {}) {
      super(message);
      this.name = 'ReaderHttpError';
      this.status = status;
      this.code = code;
      this.retryable = retryable;
    }
  }

  async function parseProxyError(res) {
    let payload = null;
    try {
      const ct = res.headers?.get?.('content-type') || '';
      if (ct.includes('application/json')) {
        payload = await res.json();
      }
    } catch (_) { }

    if (res.status === 409 || payload?.error === 'FILE_SIZE_DRIFT') {
      return new ReaderHttpError(
        'This document was recently updated in Google Drive. Refresh the page or use Download File below while the index syncs.',
        {
          status: 409,
          code: 'FILE_SIZE_DRIFT',
          retryable: false,
        }
      );
    }

    return new ReaderHttpError(
      payload?.message || `Unable to load document (HTTP ${res.status}).`,
      {
        status: res.status,
        code: payload?.error || `HTTP_${res.status}`,
        retryable: typeof payload?.retryable === 'boolean'
          ? payload.retryable
          : (res.status >= 500 || res.status === 429),
      }
    );
  }

  // ── Contract #1: Aligned 128 KB Range Transport + Single-Flight Coalescing ──

  class AlignedBucketFetcher {
    constructor({
      fileId,
      fileSize,
      versionTag = '1',
      chunkSize = CHUNK_SIZE,
      retryDelayMs = 450,
      maxTransientRetries = 1,
      fetchImpl = typeof fetch === 'function' ? fetch : null,
      signal,
      onError,
      onChunkLoaded,
    }) {
      this.fileId = fileId;
      this.fileSize = Number(fileSize);
      this.versionTag = String(versionTag || '1');
      this.chunkSize = chunkSize;
      this.retryDelayMs = retryDelayMs;
      this.maxTransientRetries = maxTransientRetries;
      this.fetchImpl = fetchImpl;
      this.signal = signal;
      this.onError = onError;
      this.onChunkLoaded = onChunkLoaded;
      /** @type {Map<number, Promise<Uint8Array>>} */
      this.inFlight = new Map();
      this.aborted = false;
    }

    abort() {
      this.aborted = true;
      this.inFlight.clear();
    }

    getBucketBounds(bucketIdx) {
      const start = bucketIdx * this.chunkSize;
      const end = Math.min(start + this.chunkSize - 1, this.fileSize - 1);
      return { start, end };
    }

    isTransientRetryable(err) {
      if (this.aborted || this.signal?.aborted) return false;
      if (!err || err.name === 'AbortError') return false;
      if (err.retryable === false) return false;
      if (typeof err.status === 'number' && err.status >= 400 && err.status < 500 && err.status !== 429) {
        return false;
      }
      return true;
    }

    fetchBucket(bucketIdx) {
      if (this.inFlight.has(bucketIdx)) {
        return this.inFlight.get(bucketIdx);
      }

      const { start, end } = this.getBucketBounds(bucketIdx);
      const url = `/api/chunk?id=${encodeURIComponent(this.fileId)}&start=${start}&end=${end}&v=${encodeURIComponent(this.versionTag)}`;

      const promise = (async () => {
        if (!this.fetchImpl) {
          throw new Error('Fetch API is unavailable.');
        }

        let attempt = 0;
        while (true) {
          try {
            const res = await this.fetchImpl(url, { signal: this.signal });
            if (!res.ok) {
              throw await parseProxyError(res);
            }
            const ab = await res.arrayBuffer();
            const bytes = new Uint8Array(ab);
            if (!this.aborted && typeof this.onChunkLoaded === 'function') {
              this.onChunkLoaded({ bucketIdx, start, end, byteLength: bytes.byteLength });
            }
            return bytes;
          } catch (err) {
            if (attempt < this.maxTransientRetries && this.isTransientRetryable(err)) {
              attempt += 1;
              await new Promise((r) => setTimeout(r, this.retryDelayMs));
              if (this.aborted || this.signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
              }
              continue;
            }
            throw err;
          }
        }
      })().finally(() => {
        this.inFlight.delete(bucketIdx);
      });

      this.inFlight.set(bucketIdx, promise);
      return promise;
    }

    /**
     * Handle PDF.js requestDataRange(begin, end) where `end` is exclusive [begin, end).
     */
    requestRange(begin, end, deliverRange) {
      if (this.aborted || !Number.isFinite(this.fileSize) || this.fileSize <= 0) {
        return Promise.resolve([]);
      }

      const clampedBegin = Math.max(0, Math.floor(begin));
      const clampedEnd = Math.min(this.fileSize, Math.ceil(end));
      if (clampedEnd <= clampedBegin) {
        return Promise.resolve([]);
      }

      const firstBucket = Math.floor(clampedBegin / this.chunkSize);
      const lastBucket = Math.floor((clampedEnd - 1) / this.chunkSize);
      const tasks = [];

      for (let bucketIdx = firstBucket; bucketIdx <= lastBucket; bucketIdx += 1) {
        const { start } = this.getBucketBounds(bucketIdx);
        tasks.push(
          this.fetchBucket(bucketIdx).then((bytes) => {
            if (!this.aborted && typeof deliverRange === 'function') {
              deliverRange(start, bytes);
            }
            return { start, bytes };
          })
        );
      }

      return Promise.all(tasks).catch((err) => {
        if (this.aborted || err?.name === 'AbortError') return [];
        if (typeof this.onError === 'function') {
          this.onError(err);
        }
        throw err;
      });
    }
  }

  function createAlignedChunkRangeTransport(pdfjsLib, opts) {
    const fetcher = new AlignedBucketFetcher(opts);
    const transport = new pdfjsLib.PDFDataRangeTransport(opts.fileSize, null);
    transport.requestDataRange = function (begin, end) {
      fetcher.requestRange(begin, end, (offset, chunk) => {
        transport.onDataRange(offset, chunk);
      }).catch(() => {});
    };
    transport.abort = function () {
      fetcher.abort();
      if (pdfjsLib.PDFDataRangeTransport.prototype.abort) {
        try {
          pdfjsLib.PDFDataRangeTransport.prototype.abort.call(transport);
        } catch (_) { }
      }
    };
    return { transport, fetcher };
  }

  // ── Contract #2: Canvas RenderTask Cancellation & GPU Bitmap Release ────────

  function evictRenderedPage(activeRenderTasks, renderedCanvases, pageNum) {
    const task = activeRenderTasks.get(pageNum);
    if (task && typeof task.cancel === 'function') {
      try {
        task.cancel();
      } catch (_) { }
    }
    activeRenderTasks.delete(pageNum);

    const canvas = renderedCanvases.get(pageNum);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      if (typeof canvas.remove === 'function') {
        canvas.remove();
      } else if (canvas.parentNode) {
        canvas.parentNode.removeChild(canvas);
      }
      renderedCanvases.delete(pageNum);
    }
  }

  // ── Virtualized PDF Session ─────────────────────────────────────────────────

  class PdfSession {
    constructor({
      resource,
      viewportEl,
      offlineRecord,
      prefs,
      savedProgress,
      versionTag,
      signal,
      onReady,
      onPageChange,
      onProgress,
      onError,
      onToast,
    }) {
      this.resource = resource;
      this.viewportEl = viewportEl;
      this.offlineRecord = offlineRecord;
      this.prefs = prefs;
      this.savedProgress = savedProgress;
      this.versionTag = versionTag;
      this.signal = signal;
      this.onReady = onReady;
      this.onPageChange = onPageChange;
      this.onProgress = onProgress;
      this.onError = onError;
      this.onToast = onToast;

      this.destroyed = false;
      this.pdfDoc = null;
      this.loadingTask = null;
      this.fetcher = null;
      this.observer = null;
      this.slots = [];
      this.activeRenderTasks = new Map();
      this.renderedCanvases = new Map();
      this.desiredWindow = new Set();
      this.pendingGetPages = new Set();
      this.numPages = 0;
      this.currentPage = 1;
      this.pageAspect = 1.4142;
      this.objectUrl = null;
    }

    async start() {
      const pdfjsLib = await ensurePdfJs();
      if (this.destroyed || this.signal.aborted) return;

      const isWorkspaceDoc = String(this.resource.mimeType || '').startsWith('application/vnd.google-apps.');
      const fileSize = Number(this.resource.fileSize);

      if (this.offlineRecord?.blob) {
        const ab = await this.offlineRecord.blob.arrayBuffer();
        if (this.destroyed || this.signal.aborted) return;
        this.loadingTask = pdfjsLib.getDocument({ data: ab, isEvalSupported: false });
      } else if (!isWorkspaceDoc && Number.isSafeInteger(fileSize) && fileSize > 0) {
        let fatalNotified = false;
        const { transport, fetcher } = createAlignedChunkRangeTransport(pdfjsLib, {
          fileId: this.resource.fileId,
          fileSize,
          versionTag: this.versionTag,
          signal: this.signal,
          onError: (err) => {
            if (!fatalNotified && !this.destroyed) {
              fatalNotified = true;
              const cb = this.onError;
              this.destroy();
              cb?.(err);
            }
          },
        });
        this.fetcher = fetcher;
        this.loadingTask = pdfjsLib.getDocument({
          length: fileSize,
          range: transport,
          rangeChunkSize: CHUNK_SIZE,
          disableAutoFetch: true,
          disableStream: true,
          isEvalSupported: false,
        });
      } else {
        const url = `/api/chunk?id=${encodeURIComponent(this.resource.fileId)}&mode=full&v=${encodeURIComponent(this.versionTag)}`;
        const res = await fetch(url, { signal: this.signal });
        if (!res.ok) throw await parseProxyError(res);
        const ab = await res.arrayBuffer();
        if (this.destroyed || this.signal.aborted) return;
        this.loadingTask = pdfjsLib.getDocument({ data: ab, isEvalSupported: false });
      }

      this.pdfDoc = await this.loadingTask.promise;
      if (this.destroyed || this.signal.aborted) return;

      this.numPages = this.pdfDoc.numPages;

      const initialPage = this.savedProgress?.unit === 'page'
        ? Math.max(1, Math.min(this.numPages, Math.round(this.savedProgress.current || 1)))
        : 1;
      this.currentPage = initialPage;

      try {
        const samplePage = await this.pdfDoc.getPage(initialPage);
        const vp = samplePage.getViewport({ scale: 1 });
        if (vp.width > 0 && vp.height > 0) {
          this.pageAspect = vp.height / vp.width;
        }
      } catch (_) { }

      if (this.destroyed || this.signal.aborted) return;

      this.buildPageSlots();
      this.applyTheme(this.prefs.theme);

      if (initialPage > 1) {
        this.scrollToSlot(initialPage, 'auto');
        this.onToast?.(`Resumed at Page ${initialPage} of ${this.numPages}`);
      }

      this.attachObserver();
      await this.renderWindowAround(initialPage);

      if (this.destroyed || this.signal.aborted) return;

      this.onReady?.({
        kind: 'pdf',
        numPages: this.numPages,
        currentPage: this.currentPage,
        supportsPages: true,
      });
      this.onPageChange?.(this.currentPage, this.numPages);
    }

    getTargetPageWidth() {
      const containerWidth = Math.max(260, (this.viewportEl.clientWidth || 360) - 24);
      const baseWidth = Math.min(containerWidth, 860);
      const zoom = this.prefs.zoomMode === 'fit-width' ? 1 : Number(this.prefs.zoomMode) || 1;
      return Math.round(baseWidth * zoom);
    }

    buildPageSlots() {
      this.viewportEl.innerHTML = '';
      const stack = document.createElement('div');
      stack.className = 'pdf-page-stack';

      const width = this.getTargetPageWidth();
      const height = Math.round(width * this.pageAspect);
      this.slots = [];

      const frag = document.createDocumentFragment();
      for (let p = 1; p <= this.numPages; p += 1) {
        const slot = document.createElement('div');
        slot.className = 'pdf-page-slot';
        slot.dataset.page = String(p);
        slot.style.width = `${width}px`;
        slot.style.height = `${height}px`;

        const label = document.createElement('span');
        label.className = 'pdf-slot-placeholder';
        label.textContent = `Page ${p} / ${this.numPages}`;
        slot.appendChild(label);

        this.slots.push(slot);
        frag.appendChild(slot);
      }

      stack.appendChild(frag);
      this.viewportEl.appendChild(stack);
    }

    resizeSlots() {
      const width = this.getTargetPageWidth();
      const height = Math.round(width * this.pageAspect);
      for (const slot of this.slots) {
        slot.style.width = `${width}px`;
        slot.style.height = `${height}px`;
      }
    }

    scrollToSlot(pageNum, behavior = 'auto') {
      const slot = this.slots[pageNum - 1];
      if (!slot) return;
      this.viewportEl.scrollTo({
        top: Math.max(0, slot.offsetTop - 8),
        behavior,
      });
    }

    attachObserver() {
      if (this.observer) {
        this.observer.disconnect();
      }
      if (typeof IntersectionObserver === 'undefined') return;

      const ratios = new Map();
      this.observer = new IntersectionObserver(
        (entries) => {
          if (this.destroyed) return;
          for (const entry of entries) {
            const p = Number(entry.target.dataset.page);
            if (entry.isIntersecting) {
              ratios.set(p, entry.intersectionRatio);
            } else {
              ratios.delete(p);
            }
          }

          let bestPage = this.currentPage;
          let bestRatio = -1;
          for (const [p, ratio] of ratios.entries()) {
            if (ratio > bestRatio) {
              bestRatio = ratio;
              bestPage = p;
            }
          }

          if (bestRatio >= 0 && bestPage !== this.currentPage) {
            this.currentPage = bestPage;
            this.onPageChange?.(this.currentPage, this.numPages);
            this.renderWindowAround(this.currentPage).catch(() => {});
          }
        },
        {
          root: this.viewportEl,
          threshold: [0.1, 0.35, 0.65],
        }
      );

      for (const slot of this.slots) {
        this.observer.observe(slot);
      }
    }

    async renderWindowAround(centerPage) {
      if (this.destroyed || !this.pdfDoc) return;
      const keepSet = new Set();
      for (let p = Math.max(1, centerPage - 1); p <= Math.min(this.numPages, centerPage + 1); p += 1) {
        keepSet.add(p);
      }
      this.desiredWindow = keepSet;

      for (const pageNum of [...this.renderedCanvases.keys(), ...this.activeRenderTasks.keys()]) {
        if (!keepSet.has(pageNum)) {
          evictRenderedPage(this.activeRenderTasks, this.renderedCanvases, pageNum);
        }
      }

      const ordered = [centerPage, centerPage - 1, centerPage + 1].filter(
        (p, idx, arr) => p >= 1 && p <= this.numPages && arr.indexOf(p) === idx
      );

      for (const pageNum of ordered) {
        if (this.destroyed || !this.desiredWindow.has(pageNum)) return;
        if (
          this.renderedCanvases.has(pageNum) ||
          this.activeRenderTasks.has(pageNum) ||
          this.pendingGetPages.has(pageNum)
        ) {
          continue;
        }
        await this.renderSinglePage(pageNum);
      }
    }

    async renderSinglePage(pageNum) {
      if (this.destroyed || !this.pdfDoc || this.pendingGetPages.has(pageNum)) return;
      const slot = this.slots[pageNum - 1];
      if (!slot) return;

      this.pendingGetPages.add(pageNum);
      try {
        const page = await this.pdfDoc.getPage(pageNum);
        if (this.destroyed || this.signal.aborted || !this.desiredWindow.has(pageNum)) {
          return;
        }

        const baseVp = page.getViewport({ scale: 1 });
        const targetCssWidth = this.getTargetPageWidth();
        const scale = targetCssWidth / Math.max(1, baseVp.width);
        const vp = page.getViewport({ scale });
        const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);

        slot.style.width = `${Math.round(vp.width)}px`;
        slot.style.height = `${Math.round(vp.height)}px`;

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        canvas.width = Math.max(1, Math.floor(vp.width * dpr));
        canvas.height = Math.max(1, Math.floor(vp.height * dpr));
        canvas.style.width = `${Math.round(vp.width)}px`;
        canvas.style.height = `${Math.round(vp.height)}px`;

        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;

        const renderTask = page.render({
          canvasContext: ctx,
          viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
        });

        this.activeRenderTasks.set(pageNum, renderTask);
        await renderTask.promise;

        if (
          this.destroyed ||
          !this.desiredWindow.has(pageNum) ||
          this.activeRenderTasks.get(pageNum) !== renderTask
        ) {
          this.activeRenderTasks.delete(pageNum);
          canvas.width = 0;
          canvas.height = 0;
          return;
        }

        this.activeRenderTasks.delete(pageNum);
        slot.querySelectorAll('.pdf-page-canvas').forEach((old) => {
          old.width = 0;
          old.height = 0;
          old.remove();
        });
        this.renderedCanvases.set(pageNum, canvas);
        slot.appendChild(canvas);
      } catch (err) {
        if (err?.name === 'RenderingCancelledException' || err?.name === 'AbortError' || this.destroyed) {
          return;
        }
        this.activeRenderTasks.delete(pageNum);
      } finally {
        this.pendingGetPages.delete(pageNum);
      }
    }

    jumpToPage(pageNum) {
      if (!this.numPages) return;
      const target = Math.max(1, Math.min(this.numPages, Math.round(Number(pageNum) || 1)));
      this.currentPage = target;
      this.scrollToSlot(target, 'auto');
      this.onPageChange?.(this.currentPage, this.numPages);
      this.renderWindowAround(target).catch(() => {});
    }

    setZoom(zoomMode) {
      this.prefs.zoomMode = zoomMode;
      const anchorPage = this.currentPage;
      for (const pageNum of [...this.renderedCanvases.keys(), ...this.activeRenderTasks.keys()]) {
        evictRenderedPage(this.activeRenderTasks, this.renderedCanvases, pageNum);
      }
      this.resizeSlots();
      this.scrollToSlot(anchorPage, 'auto');
      this.renderWindowAround(anchorPage).catch(() => {});
    }

    applyTheme(theme) {
      this.prefs.theme = theme;
      this.viewportEl.dataset.readerTheme = theme;
    }

    destroy() {
      this.destroyed = true;
      this.desiredWindow.clear();
      this.pendingGetPages.clear();
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      if (this.fetcher) {
        this.fetcher.abort();
        this.fetcher = null;
      }
      for (const pageNum of [...this.renderedCanvases.keys(), ...this.activeRenderTasks.keys()]) {
        evictRenderedPage(this.activeRenderTasks, this.renderedCanvases, pageNum);
      }
      if (this.loadingTask && typeof this.loadingTask.destroy === 'function') {
        this.loadingTask.destroy().catch(() => {});
      }
      if (this.pdfDoc && typeof this.pdfDoc.destroy === 'function') {
        this.pdfDoc.destroy().catch(() => {});
      }
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
      }
      this.slots = [];
      this.viewportEl.innerHTML = '';
    }
  }

  // ── Reflowable DOCX Session (Mammoth + DOMPurify) ───────────────────────────

  class DocxSession {
    constructor({
      resource,
      viewportEl,
      offlineRecord,
      prefs,
      savedProgress,
      versionTag,
      signal,
      onReady,
      onScrollProgress,
      onProgress,
      onToast,
    }) {
      this.resource = resource;
      this.viewportEl = viewportEl;
      this.offlineRecord = offlineRecord;
      this.prefs = prefs;
      this.savedProgress = savedProgress;
      this.versionTag = versionTag;
      this.signal = signal;
      this.onReady = onReady;
      this.onScrollProgress = onScrollProgress;
      this.onProgress = onProgress;
      this.onToast = onToast;

      this.destroyed = false;
      this.scrollHandler = null;
    }

    async start() {
      const size = Number(this.resource.fileSize);
      if (Number.isFinite(size) && size > MAX_DOCX_BYTES) {
        throw new ReaderHttpError(
          `Word document (${formatBytes(size)}) exceeds the ${formatBytes(MAX_DOCX_BYTES)} inline reader limit. Please download it directly.`,
          { status: 413, code: 'DOCX_SIZE_LIMIT', retryable: false }
        );
      }

      const [{ mammoth, DOMPurify }, arrayBuffer] = await Promise.all([
        ensureDocxLibs(),
        this.loadArrayBuffer(),
      ]);
      if (this.destroyed || this.signal.aborted) return;

      const result = await mammoth.convertToHtml({ arrayBuffer });
      if (this.destroyed || this.signal.aborted) return;

      const cleanHtml = sanitizeDocxHtml(result.value, DOMPurify);

      const article = document.createElement('article');
      article.className = 'reader-prose-doc';
      article.innerHTML = cleanHtml || '<p>This document appears to be empty.</p>';
      hardenDocxArticleDom(article);

      this.viewportEl.innerHTML = '';
      this.viewportEl.appendChild(article);
      this.applyTypography();

      if (this.savedProgress?.unit === 'percent' && this.savedProgress.current > 0) {
        requestAnimationFrame(() => {
          if (this.destroyed) return;
          const maxScroll = Math.max(0, this.viewportEl.scrollHeight - this.viewportEl.clientHeight);
          if (maxScroll > 0) {
            this.viewportEl.scrollTop = Math.round((this.savedProgress.current / 100) * maxScroll);
            this.onToast?.(`Resumed at ${Math.round(this.savedProgress.current)}%`);
          }
        });
      }

      this.scrollHandler = () => {
        if (this.destroyed) return;
        const maxScroll = Math.max(1, this.viewportEl.scrollHeight - this.viewportEl.clientHeight);
        const pct = Math.min(100, Math.max(0, Math.round((this.viewportEl.scrollTop / maxScroll) * 100)));
        this.onScrollProgress?.(pct);
      };
      this.viewportEl.addEventListener('scroll', this.scrollHandler, { passive: true });

      this.onReady?.({ kind: 'docx', supportsTypography: true });
    }

    async loadArrayBuffer() {
      if (this.offlineRecord?.blob) {
        return this.offlineRecord.blob.arrayBuffer();
      }
      const url = `/api/chunk?id=${encodeURIComponent(this.resource.fileId)}&mode=full&v=${encodeURIComponent(this.versionTag)}`;
      const res = await fetch(url, { signal: this.signal });
      if (!res.ok) throw await parseProxyError(res);

      const total = Number(res.headers.get('content-length')) || Number(this.resource.fileSize) || 0;
      if (!res.body || typeof res.body.getReader !== 'function') {
        const ab = await res.arrayBuffer();
        if (ab.byteLength > MAX_DOCX_BYTES) {
          throw new ReaderHttpError('Document exceeds inline reader limit.', { status: 413, retryable: false });
        }
        return ab;
      }

      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          loaded += value.byteLength;
          if (loaded > MAX_DOCX_BYTES) {
            await reader.cancel().catch(() => {});
            throw new ReaderHttpError('Document exceeds inline reader limit.', { status: 413, retryable: false });
          }
          chunks.push(value);
          this.onProgress?.({
            loaded,
            total: total || loaded,
            percent: total ? Math.min(100, Math.round((loaded / total) * 100)) : null,
          });
        }
      } finally {
        try { reader.releaseLock(); } catch (_) { }
      }

      const out = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out.buffer;
    }

    applyTypography() {
      this.viewportEl.dataset.readerTheme = this.prefs.theme;
      const article = this.viewportEl.querySelector('.reader-prose-doc');
      if (article) {
        article.style.fontSize = `${this.prefs.fontSize}px`;
        article.dataset.fontFamily = this.prefs.fontFamily;
      }
    }

    setPrefs(prefs) {
      this.prefs = prefs;
      this.applyTypography();
    }

    destroy() {
      this.destroyed = true;
      if (this.scrollHandler) {
        this.viewportEl.removeEventListener('scroll', this.scrollHandler);
        this.scrollHandler = null;
      }
      this.viewportEl.innerHTML = '';
    }
  }

  // ── Plain Text / Code / Markdown Session ────────────────────────────────────

  class TextSession {
    constructor({
      resource,
      viewportEl,
      offlineRecord,
      prefs,
      savedProgress,
      versionTag,
      signal,
      onReady,
      onScrollProgress,
      onToast,
    }) {
      this.resource = resource;
      this.viewportEl = viewportEl;
      this.offlineRecord = offlineRecord;
      this.prefs = prefs;
      this.savedProgress = savedProgress;
      this.versionTag = versionTag;
      this.signal = signal;
      this.onReady = onReady;
      this.onScrollProgress = onScrollProgress;
      this.onToast = onToast;

      this.destroyed = false;
      this.scrollHandler = null;
      this.rawText = '';
    }

    async start() {
      const size = Number(this.resource.fileSize);
      if (Number.isFinite(size) && size > MAX_TEXT_BYTES) {
        throw new ReaderHttpError(
          `Text file (${formatBytes(size)}) exceeds the ${formatBytes(MAX_TEXT_BYTES)} inline limit.`,
          { status: 413, code: 'TEXT_SIZE_LIMIT', retryable: false }
        );
      }

      if (this.offlineRecord?.blob) {
        this.rawText = await this.offlineRecord.blob.text();
      } else {
        const url = `/api/chunk?id=${encodeURIComponent(this.resource.fileId)}&mode=full&v=${encodeURIComponent(this.versionTag)}`;
        const res = await fetch(url, { signal: this.signal });
        if (!res.ok) throw await parseProxyError(res);
        const ab = await res.arrayBuffer();
        if (ab.byteLength > MAX_TEXT_BYTES) {
          throw new ReaderHttpError('Text file exceeds inline limit.', { status: 413, retryable: false });
        }
        this.rawText = new TextDecoder('utf-8').decode(ab);
      }
      if (this.destroyed || this.signal.aborted) return;

      const wrap = document.createElement('div');
      wrap.className = 'reader-text-container';

      const toolbar = document.createElement('div');
      toolbar.className = 'reader-text-subbar';
      toolbar.innerHTML = `
        <button type="button" class="btn-reader-chip" data-text-action="wrap">Wrap: ${this.prefs.wordWrap ? 'On' : 'Off'}</button>
        <button type="button" class="btn-reader-chip" data-text-action="copy">Copy Text</button>
      `;

      const pre = document.createElement('pre');
      pre.className = `reader-code-pre${this.prefs.wordWrap ? ' is-wrapped' : ''}`;
      pre.textContent = this.rawText;

      wrap.appendChild(toolbar);
      wrap.appendChild(pre);
      this.viewportEl.innerHTML = '';
      this.viewportEl.appendChild(wrap);
      this.applyTypography();

      toolbar.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-text-action]');
        if (!btn) return;
        const action = btn.dataset.textAction;
        if (action === 'wrap') {
          this.prefs = FocitStorage.ReaderPrefsStore.update({ wordWrap: !this.prefs.wordWrap });
          pre.classList.toggle('is-wrapped', this.prefs.wordWrap);
          btn.textContent = `Wrap: ${this.prefs.wordWrap ? 'On' : 'Off'}`;
        } else if (action === 'copy') {
          try {
            await navigator.clipboard.writeText(this.rawText);
            this.onToast?.('Copied text to clipboard');
          } catch (_) {
            this.onToast?.('Clipboard unavailable');
          }
        }
      });

      if (this.savedProgress?.unit === 'percent' && this.savedProgress.current > 0) {
        requestAnimationFrame(() => {
          if (this.destroyed) return;
          const maxScroll = Math.max(0, this.viewportEl.scrollHeight - this.viewportEl.clientHeight);
          if (maxScroll > 0) {
            this.viewportEl.scrollTop = Math.round((this.savedProgress.current / 100) * maxScroll);
          }
        });
      }

      this.scrollHandler = () => {
        if (this.destroyed) return;
        const maxScroll = Math.max(1, this.viewportEl.scrollHeight - this.viewportEl.clientHeight);
        const pct = Math.min(100, Math.max(0, Math.round((this.viewportEl.scrollTop / maxScroll) * 100)));
        this.onScrollProgress?.(pct);
      };
      this.viewportEl.addEventListener('scroll', this.scrollHandler, { passive: true });

      this.onReady?.({ kind: 'text', supportsTypography: true });
    }

    applyTypography() {
      this.viewportEl.dataset.readerTheme = this.prefs.theme;
      const pre = this.viewportEl.querySelector('.reader-code-pre');
      if (pre) {
        pre.style.fontSize = `${Math.max(12, this.prefs.fontSize - 1)}px`;
      }
    }

    setPrefs(prefs) {
      this.prefs = prefs;
      this.applyTypography();
    }

    destroy() {
      this.destroyed = true;
      if (this.scrollHandler) {
        this.viewportEl.removeEventListener('scroll', this.scrollHandler);
        this.scrollHandler = null;
      }
      this.rawText = '';
      this.viewportEl.innerHTML = '';
    }
  }

  // ── Clean Degraded Slide / Office Card (Option 2B) ──────────────────────────

  class SlideCardSession {
    constructor({ resource, viewportEl, savedProgress, onReady, onToggleDone }) {
      this.resource = resource;
      this.viewportEl = viewportEl;
      this.savedProgress = savedProgress;
      this.onReady = onReady;
      this.onToggleDone = onToggleDone;
      this.destroyed = false;
    }

    async start() {
      const ext = String(this.resource.fileExt || 'FILE').toUpperCase();
      const sizeStr = formatBytes(this.resource.fileSize) || 'Unknown size';
      const isCompleted = Boolean(this.savedProgress?.completed);
      const downloadUrl = getSafeDownloadUrl(this.resource);
      const previewUrl = getSafePreviewUrl(this.resource);

      const card = document.createElement('section');
      card.className = 'reader-slide-card';
      card.innerHTML = `
        <div class="slide-card-badge">${escHtml(ext)}</div>
        <h3 class="slide-card-title">${escHtml(this.resource.fileName || this.resource.courseTitle)}</h3>
        <p class="slide-card-sub">
          ${escHtml(this.resource.courseCode || 'GENERAL')} · ${escHtml(sizeStr)}
        </p>
        <p class="slide-card-note">
          PowerPoint &amp; Office binary decks open best in your device's native slide viewer or offline copy.
        </p>
        <div class="slide-card-actions">
          <a href="${escHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer" class="btn-slide-primary">
            Download ${escHtml(ext)} (${escHtml(sizeStr)})
          </a>
          <button type="button" id="btn-slide-mark-done" class="btn-slide-secondary${isCompleted ? ' is-done' : ''}">
            ${isCompleted ? '✓ Marked as Studied' : 'Mark as Studied'}
          </button>
          <button type="button" id="btn-slide-fallback" class="btn-slide-ghost">
            Try Embedded Preview
          </button>
        </div>
        <div id="slide-fallback-slot" class="slide-fallback-slot hidden"></div>
      `;

      this.viewportEl.innerHTML = '';
      this.viewportEl.appendChild(card);

      const markBtn = card.querySelector('#btn-slide-mark-done');
      markBtn?.addEventListener('click', () => {
        const nextDone = !markBtn.classList.contains('is-done');
        markBtn.classList.toggle('is-done', nextDone);
        markBtn.textContent = nextDone ? '✓ Marked as Studied' : 'Mark as Studied';
        this.onToggleDone?.(nextDone);
      });

      const fallbackBtn = card.querySelector('#btn-slide-fallback');
      const fallbackSlot = card.querySelector('#slide-fallback-slot');
      fallbackBtn?.addEventListener('click', () => {
        if (!SAFE_DRIVE_URL_RE.test(previewUrl)) return;
        fallbackBtn.disabled = true;
        fallbackBtn.textContent = 'Loaded Embedded Preview';
        fallbackSlot.classList.remove('hidden');
        const iframe = document.createElement('iframe');
        iframe.src = previewUrl;
        iframe.title = `${this.resource.fileName || 'Document'} fallback preview`;
        iframe.className = 'slide-fallback-iframe';
        fallbackSlot.appendChild(iframe);
      });

      this.onReady?.({ kind: 'slide-card' });
    }

    destroy() {
      this.destroyed = true;
      this.viewportEl.innerHTML = '';
    }
  }

  // ── DocumentReaderController ────────────────────────────────────────────────

  class DocumentReaderController {
    constructor(opts = {}) {
      this.dom = opts.dom || {};
      this.getVersionTag = typeof opts.getVersionTag === 'function' ? opts.getVersionTag : () => '1';
      this.onProgressUpdated = typeof opts.onProgressUpdated === 'function' ? opts.onProgressUpdated : () => {};
      this.onOfflineUpdated = typeof opts.onOfflineUpdated === 'function' ? opts.onOfflineUpdated : () => {};
      this.onCloseSyncUrl = typeof opts.onCloseSyncUrl === 'function' ? opts.onCloseSyncUrl : () => {};

      this.activeSessionId = 0;
      this.activeController = null;
      this.offlineController = null;
      this.currentSession = null;
      this.currentResource = null;
      this.lastTrigger = null;
      this.toastTimer = null;
      this.offlineBusy = false;
    }

    isOpen() {
      return Boolean(this.dom.dialog?.open);
    }

    showToast(message) {
      if (!this.dom.toast) return;
      this.dom.toast.textContent = message;
      this.dom.toast.classList.remove('hidden');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        this.dom.toast?.classList.add('hidden');
      }, 2600);
    }

    setLoadingState({ title = 'Loading document…', detail = '', percent = null } = {}) {
      if (!this.dom.loadingOverlay) return;
      this.dom.loadingOverlay.classList.remove('hidden');
      if (this.dom.loadingTitle) this.dom.loadingTitle.textContent = title;
      if (this.dom.loadingDetail) this.dom.loadingDetail.textContent = detail;
      if (this.dom.loadingBar) {
        if (percent === null) {
          this.dom.loadingBar.classList.add('is-indeterminate');
          this.dom.loadingBar.style.width = '40%';
        } else {
          this.dom.loadingBar.classList.remove('is-indeterminate');
          this.dom.loadingBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        }
      }
    }

    hideLoadingState() {
      this.dom.loadingOverlay?.classList.add('hidden');
    }

    renderErrorState(err) {
      this.hideLoadingState();
      if (!this.dom.viewport) return;

      const downloadUrl = getSafeDownloadUrl(this.currentResource);
      const msg = err?.message || 'Unable to load this document.';
      const retryable = err?.retryable !== false;

      this.dom.viewport.innerHTML = `
        <div class="reader-error-card" role="alert">
          <p class="reader-error-title">Could not open document</p>
          <p class="reader-error-msg">${escHtml(msg)}</p>
          <div class="reader-error-actions">
            ${retryable ? '<button type="button" id="btn-reader-retry" class="btn-slide-primary">Retry</button>' : ''}
            <a href="${escHtml(downloadUrl)}" target="_blank" rel="noopener noreferrer" class="btn-slide-secondary">Download File</a>
          </div>
        </div>
      `;

      const retryBtn = this.dom.viewport.querySelector('#btn-reader-retry');
      retryBtn?.addEventListener('click', () => {
        if (!this.currentResource) return;
        retryBtn.disabled = true;
        retryBtn.setAttribute('aria-busy', 'true');
        this.open(this.currentResource, { triggerBtn: this.lastTrigger, skipHistoryPush: true });
      });
    }

    configureControls(capabilities = {}) {
      if (this.dom.scrubberBar) {
        this.dom.scrubberBar.classList.toggle('hidden', !capabilities.supportsPages);
      }
      if (this.dom.typoControls) {
        this.dom.typoControls.classList.toggle('hidden', !capabilities.supportsTypography);
      }
      if (this.dom.zoomControls) {
        this.dom.zoomControls.classList.toggle('hidden', !capabilities.supportsPages);
      }
      const supportsDisplay = Boolean(capabilities.supportsPages || capabilities.supportsTypography);
      if (this.dom.btnDisplay) {
        this.dom.btnDisplay.classList.toggle('hidden', !supportsDisplay);
        if (!supportsDisplay) {
          this.dom.btnDisplay.setAttribute('aria-expanded', 'false');
        }
      }
      if (!supportsDisplay && this.dom.displayBar) {
        this.dom.displayBar.classList.add('hidden');
      }
    }

    async refreshOfflineButtonState() {
      const btn = this.dom.btnSaveOffline;
      const res = this.currentResource;
      if (!btn || !res) return;

      const ext = String(res.fileExt || '').toUpperCase();
      const supported = ['PDF', 'GDOC', 'GSLIDES', 'DOCX', 'TXT', 'MD', 'CSV'].includes(ext);
      btn.classList.toggle('hidden', !supported);
      if (!supported) return;

      const cached = await FocitStorage.OfflineBlobCache.has(res.fileId);
      btn.dataset.cached = cached ? '1' : '0';
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if (this.dom.saveOfflineLabel) {
        this.dom.saveOfflineLabel.textContent = cached ? 'Saved Offline' : 'Save Offline';
      }
      btn.classList.toggle('is-saved', cached);
    }

    async toggleSaveOffline() {
      const btn = this.dom.btnSaveOffline;
      const res = this.currentResource;
      if (!btn || !res || this.offlineBusy) return;

      if (btn.dataset.cached === '1') {
        this.offlineBusy = true;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        try {
          await FocitStorage.OfflineBlobCache.remove(res.fileId);
          this.showToast('Removed from offline storage');
          await this.refreshOfflineButtonState();
          this.onOfflineUpdated();
        } finally {
          this.offlineBusy = false;
        }
        return;
      }

      const size = Number(res.fileSize) || 0;
      if (size > 10 * 1024 * 1024) {
        const mb = (size / 1048576).toFixed(1);
        const ok = globalThis.confirm?.(`Save ${mb} MB offline on this device?`);
        if (!ok) return;
      }

      this.offlineBusy = true;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      this.offlineController = new AbortController();

      try {
        await FocitStorage.OfflineBlobCache.downloadAndSave({
          resource: res,
          versionTag: this.getVersionTag(),
          signal: this.offlineController.signal,
          onProgress: ({ percent }) => {
            if (this.dom.saveOfflineLabel && percent !== null) {
              this.dom.saveOfflineLabel.textContent = `Saving ${percent}%`;
            }
          },
        });
        this.showToast('Saved for offline reading');
        await this.refreshOfflineButtonState();
        this.onOfflineUpdated();
      } catch (err) {
        this.offlineController?.abort();
        if (err?.name !== 'AbortError') {
          this.showToast(err?.message || 'Failed to save offline');
        }
        await this.refreshOfflineButtonState();
      } finally {
        this.offlineBusy = false;
        this.offlineController = null;
      }
    }

    async open(resource, { triggerBtn = null, skipHistoryPush = false } = {}) {
      if (!resource || !this.dom.dialog) return;

      FocitStorage.ProgressStore.flushPending();
      this.teardownSession();

      this.activeSessionId += 1;
      const sessionId = this.activeSessionId;
      this.activeController = new AbortController();
      this.currentResource = resource;
      this.lastTrigger = triggerBtn || this.lastTrigger;

      const ext = String(resource.fileExt || 'PDF').toUpperCase();
      if (this.dom.courseCode) this.dom.courseCode.textContent = resource.courseCode || 'GENERAL';
      if (this.dom.fileExt) {
        this.dom.fileExt.textContent = ext;
        this.dom.fileExt.className = `ext-badge ext-${ext.toLowerCase()}`;
      }
      if (this.dom.title) {
        this.dom.title.textContent = resource.fileName || resource.courseTitle || 'Document Reader';
        this.dom.title.title = resource.fileName || '';
      }
      if (this.dom.btnDownload) {
        this.dom.btnDownload.href = getSafeDownloadUrl(resource);
      }

      this.configureControls({});
      if (this.dom.displayBar) this.dom.displayBar.classList.add('hidden');
      if (this.dom.btnDisplay) this.dom.btnDisplay.setAttribute('aria-expanded', 'false');
      this.refreshOfflineButtonState().catch(() => {});

      const savedProgress = FocitStorage.ProgressStore.get(resource.id);
      this.syncCompletedToggleUI(Boolean(savedProgress?.completed));

      const prefs = FocitStorage.ReaderPrefsStore.get();
      if (this.dom.viewport) {
        this.dom.viewport.dataset.readerTheme = prefs.theme;
      }

      if (!skipHistoryPush && typeof history !== 'undefined' && typeof history.pushState === 'function') {
        const params = new URLSearchParams(window.location.search);
        if (params.get('doc') !== resource.id) {
          params.set('doc', resource.id);
          const nextUrl = `${window.location.pathname}?${params.toString()}`;
          try {
            history.pushState({ readerOpened: true, doc: resource.id }, '', nextUrl);
          } catch (_) { }
        }
      }

      if (typeof document !== 'undefined') {
        document.documentElement?.classList?.add('dialog-open-lock');
        if (document.body) {
          document.body.style.overflow = 'hidden';
        }
      }
      if (!this.dom.dialog.open) {
        this.dom.dialog.showModal();
      }
      this.dom.btnClose?.focus?.();

      this.setLoadingState({
        title: savedProgress?.unit === 'page'
          ? `Resuming at Page ${savedProgress.current}…`
          : `Opening ${resource.fileName || 'document'}…`,
        detail: formatBytes(resource.fileSize),
        percent: null,
      });

      const offlineRecord = await FocitStorage.OfflineBlobCache.get(resource.fileId);
      if (sessionId !== this.activeSessionId || this.activeController.signal.aborted) return;

      const commonArgs = {
        resource,
        viewportEl: this.dom.viewport,
        offlineRecord,
        prefs,
        savedProgress,
        versionTag: this.getVersionTag(),
        signal: this.activeController.signal,
        onProgress: ({ loaded, total, percent }) => {
          if (sessionId !== this.activeSessionId) return;
          this.setLoadingState({
            title: `Loading ${ext}…`,
            detail: total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : formatBytes(loaded),
            percent,
          });
        },
        onToast: (msg) => {
          if (sessionId === this.activeSessionId) this.showToast(msg);
        },
      };

      try {
        if (ext === 'PDF' || ext === 'GDOC' || ext === 'GSLIDES') {
          this.currentSession = new PdfSession({
            ...commonArgs,
            onReady: (caps) => {
              if (sessionId !== this.activeSessionId) return;
              this.hideLoadingState();
              this.configureControls(caps);
              if (this.dom.pageRange) {
                this.dom.pageRange.min = '1';
                this.dom.pageRange.max = String(caps.numPages);
                this.dom.pageRange.value = String(caps.currentPage);
              }
            },
            onPageChange: (page, total) => {
              if (sessionId !== this.activeSessionId) return;
              if (this.dom.pageLabel) this.dom.pageLabel.textContent = `Page ${page} / ${total}`;
              if (this.dom.pageRange) this.dom.pageRange.value = String(page);
              if (this.dom.pageInput) this.dom.pageInput.value = String(page);
              FocitStorage.ProgressStore.scheduleSave({
                resourceId: resource.id,
                fileId: resource.fileId,
                courseCode: resource.courseCode,
                title: resource.fileName || resource.courseTitle,
                fileExt: ext,
                unit: 'page',
                current: page,
                total,
              });
              this.syncCompletedToggleUI(page / Math.max(1, total) >= 0.95);
              this.onProgressUpdated();
            },
            onError: (err) => {
              if (sessionId !== this.activeSessionId) return;
              this.teardownSession();
              this.configureControls({});
              this.renderErrorState(err);
            },
          });
        } else if (ext === 'DOCX') {
          this.currentSession = new DocxSession({
            ...commonArgs,
            onReady: (caps) => {
              if (sessionId !== this.activeSessionId) return;
              this.hideLoadingState();
              this.configureControls(caps);
            },
            onScrollProgress: (pct) => {
              if (sessionId !== this.activeSessionId) return;
              FocitStorage.ProgressStore.scheduleSave({
                resourceId: resource.id,
                fileId: resource.fileId,
                courseCode: resource.courseCode,
                title: resource.fileName || resource.courseTitle,
                fileExt: ext,
                unit: 'percent',
                current: pct,
                total: 100,
                percent: pct,
              });
              this.syncCompletedToggleUI(pct >= 95);
              this.onProgressUpdated();
            },
          });
        } else if (ext === 'TXT' || ext === 'MD' || ext === 'CSV') {
          this.currentSession = new TextSession({
            ...commonArgs,
            onReady: (caps) => {
              if (sessionId !== this.activeSessionId) return;
              this.hideLoadingState();
              this.configureControls(caps);
            },
            onScrollProgress: (pct) => {
              if (sessionId !== this.activeSessionId) return;
              FocitStorage.ProgressStore.scheduleSave({
                resourceId: resource.id,
                fileId: resource.fileId,
                courseCode: resource.courseCode,
                title: resource.fileName || resource.courseTitle,
                fileExt: ext,
                unit: 'percent',
                current: pct,
                total: 100,
                percent: pct,
              });
              this.syncCompletedToggleUI(pct >= 95);
              this.onProgressUpdated();
            },
          });
        } else {
          this.currentSession = new SlideCardSession({
            resource,
            viewportEl: this.dom.viewport,
            savedProgress,
            onReady: (caps) => {
              if (sessionId !== this.activeSessionId) return;
              this.hideLoadingState();
              this.configureControls(caps);
            },
            onToggleDone: (done) => {
              FocitStorage.ProgressStore.markCompleted(resource.id, done, {
                fileId: resource.fileId,
                courseCode: resource.courseCode,
                title: resource.fileName || resource.courseTitle,
                fileExt: ext,
              });
              this.syncCompletedToggleUI(done);
              this.onProgressUpdated();
            },
          });
        }

        await this.currentSession.start();
      } catch (err) {
        if (sessionId !== this.activeSessionId || err?.name === 'AbortError') return;
        this.teardownSession();
        this.configureControls({});
        this.renderErrorState(err);
      }
    }

    syncCompletedToggleUI(completed) {
      if (!this.dom.btnMarkDone) return;
      this.dom.btnMarkDone.classList.toggle('is-done', Boolean(completed));
      this.dom.btnMarkDone.setAttribute('aria-pressed', completed ? 'true' : 'false');
    }

    toggleMarkCompleted() {
      const res = this.currentResource;
      if (!res) return;
      const nextDone = !this.dom.btnMarkDone?.classList.contains('is-done');
      FocitStorage.ProgressStore.markCompleted(res.id, nextDone, {
        fileId: res.fileId,
        courseCode: res.courseCode,
        title: res.fileName || res.courseTitle,
        fileExt: res.fileExt,
      });
      this.syncCompletedToggleUI(nextDone);
      this.showToast(nextDone ? 'Marked as completed' : 'Marked as in progress');
      this.onProgressUpdated();
    }

    setTheme(theme) {
      const prefs = FocitStorage.ReaderPrefsStore.update({ theme });
      if (this.dom.viewport) this.dom.viewport.dataset.readerTheme = prefs.theme;
      if (this.currentSession?.applyTheme) this.currentSession.applyTheme(prefs.theme);
      if (this.currentSession?.setPrefs) this.currentSession.setPrefs(prefs);
    }

    adjustFontSize(delta) {
      const curr = FocitStorage.ReaderPrefsStore.get();
      const prefs = FocitStorage.ReaderPrefsStore.update({ fontSize: curr.fontSize + delta });
      if (this.currentSession?.setPrefs) this.currentSession.setPrefs(prefs);
    }

    toggleFontFamily() {
      const curr = FocitStorage.ReaderPrefsStore.get();
      const next = curr.fontFamily === 'sans' ? 'serif' : 'sans';
      const prefs = FocitStorage.ReaderPrefsStore.update({ fontFamily: next });
      if (this.currentSession?.setPrefs) this.currentSession.setPrefs(prefs);
      return prefs.fontFamily;
    }

    setZoom(zoomMode) {
      const prefs = FocitStorage.ReaderPrefsStore.update({ zoomMode });
      if (this.currentSession?.setZoom) this.currentSession.setZoom(prefs.zoomMode);
    }

    jumpToPage(pageNum) {
      if (this.currentSession?.jumpToPage) {
        this.currentSession.jumpToPage(pageNum);
      }
    }

    teardownSession() {
      if (this.activeController) {
        this.activeController.abort();
        this.activeController = null;
      }
      if (this.offlineController) {
        this.offlineController.abort();
        this.offlineController = null;
      }
      if (this.currentSession) {
        this.currentSession.destroy();
        this.currentSession = null;
      }
      this.hideLoadingState();
    }

    close({ fromPopstate = false } = {}) {
      FocitStorage.ProgressStore.flushPending();
      this.activeSessionId += 1;
      this.teardownSession();
      this.configureControls({});

      if (this.dom.dialog?.open) {
        this.dom.dialog.close();
      }
      if (typeof document !== 'undefined') {
        if (!document.querySelector('dialog[open]')) {
          document.documentElement?.classList?.remove('dialog-open-lock');
        }
        if (document.body) {
          document.body.style.overflow = '';
        }
      }

      if (!fromPopstate && typeof history !== 'undefined') {
        if (history.state?.readerOpened) {
          history.back();
        } else {
          this.onCloseSyncUrl();
        }
      }

      this.onProgressUpdated();
      if (this.lastTrigger && typeof this.lastTrigger.focus === 'function') {
        this.lastTrigger.focus();
      }
    }
  }

  return {
    CHUNK_SIZE,
    MAX_DOCX_BYTES,
    MAX_TEXT_BYTES,
    VENDOR_PATHS,
    DOC_SANITIZE_CONFIG,
    getSafeDownloadUrl,
    getSafePreviewUrl,
    hardenDocxArticleDom,
    invalidateVendorScript,
    loadVendorScript,
    AlignedBucketFetcher,
    createAlignedChunkRangeTransport,
    evictRenderedPage,
    sanitizeDocxHtml,
    parseProxyError,
    PdfSession,
    DocxSession,
    TextSession,
    SlideCardSession,
    DocumentReaderController,
    ReaderHttpError,
  };
});
