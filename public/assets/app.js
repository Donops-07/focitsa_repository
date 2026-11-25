/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Client Application Logic
   Zero-trust client: strict escaping, URL state sync, monotonic search IDs,
   mobile-first course grouping, in-place progress patching, and reader wiring.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const PREF_KEY = 'focit_prefs_v2';
const PAGE_SIZE = 100;
const SAFE_DRIVE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const SAFE_DRIVE_URL_RE = /^https:\/\/(drive|docs)\.google\.com\//;
const SHARED_COURSE_PREFIXES = new Set(['GST', 'MTH', 'ESI', 'STA', 'ENT', 'GNS']);

const TYPE_CLASS = {
  'Past Question': 'past-question',
  'Lecture Notes': 'lecture-notes',
  'Tutorial': 'tutorial',
  'Syllabus': 'syllabus',
  'Textbook': 'textbook',
  'Resource': 'resource',
};

const TYPE_SORT_ORDER = {
  'Past Question': 1,
  'Lecture Notes': 2,
  'Syllabus': 3,
  'Tutorial': 4,
  'Textbook': 5,
  'Resource': 6,
};

const EXT_CLASS = {
  PDF: 'ext-pdf',
  DOCX: 'ext-docx',
  DOC: 'ext-doc',
  GDOC: 'ext-gdoc',
  PPTX: 'ext-pptx',
  PPT: 'ext-ppt',
  GSLIDES: 'ext-gslides',
  XLSX: 'ext-xlsx',
  XLS: 'ext-xls',
  GSHEET: 'ext-gsheet',
  TXT: 'ext-txt',
  MD: 'ext-md',
  ZIP: 'ext-zip',
};

// ── Application State ─────────────────────────────────────────────────────────

const state = {
  allResources: [],
  resourceById: new Map(),
  searchResults: null,
  filters: {
    dept: '',
    level: '',
    sem: '',
    type: '',
    year: '',
  },
  query: '',
  pendingDocId: '',
  usingSavedPrefs: false,
  visibleLimit: PAGE_SIZE,
  indexReady: false,
  hasError: false,
  latestSearchRequestId: 0,
  offlineFileIds: new Set(),
  openCourseKeys: new Set(),
  closedCourseKeys: new Set(),
  courseCategoryTab: new Map(),
  renderedGroupItems: new Map(),
  appToastTimer: null,
};

// ── DOM References ────────────────────────────────────────────────────────────

const dom = {
  headerTotalBadge: document.getElementById('header-total-badge'),
  btnCopyLink: document.getElementById('btn-copy-link'),
  copyLinkLabel: document.getElementById('copy-link-label'),

  continueSection: document.getElementById('continue-reading-section'),
  continueList: document.getElementById('continue-reading-list'),

  searchInput: document.getElementById('search-input'),
  searchKbd: document.getElementById('search-kbd'),
  searchClear: document.getElementById('search-clear'),

  mobileChipBar: document.getElementById('mobile-chip-bar'),
  btnOpenFilterSheet: document.getElementById('btn-open-filter-sheet'),
  mobileFilterBadge: document.getElementById('mobile-filter-badge'),

  filterBar: document.querySelector('.filter-bar'),
  filterDept: document.getElementById('filter-dept'),
  filterLevel: document.getElementById('filter-level'),
  filterSem: document.getElementById('filter-sem'),
  filterType: document.getElementById('filter-type'),
  filterYear: document.getElementById('filter-year'),
  btnResetFilters: document.getElementById('btn-reset-filters'),

  filterSheet: document.getElementById('mobile-filter-sheet'),
  btnSheetClose: document.getElementById('btn-sheet-close'),
  sheetDept: document.getElementById('sheet-dept'),
  sheetLevel: document.getElementById('sheet-level'),
  sheetSem: document.getElementById('sheet-sem'),
  sheetType: document.getElementById('sheet-type'),
  sheetYear: document.getElementById('sheet-year'),
  btnSheetReset: document.getElementById('btn-sheet-reset'),
  btnSheetApply: document.getElementById('btn-sheet-apply'),

  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  savedPrefsNotice: document.getElementById('saved-prefs-notice'),
  resultCount: document.getElementById('result-count'),

  resultsGrid: document.getElementById('results-grid'),
  paginationBar: document.getElementById('pagination-bar'),
  btnLoadMore: document.getElementById('btn-load-more'),
  appToast: document.getElementById('app-toast'),

  readerDialog: document.getElementById('reader-dialog'),
  readerClose: document.getElementById('reader-close'),
  readerCourseCode: document.getElementById('reader-course-code'),
  readerFileExt: document.getElementById('reader-file-ext'),
  readerTitle: document.getElementById('reader-title'),
  readerBtnOffline: document.getElementById('reader-btn-offline'),
  readerOfflineLabel: document.getElementById('reader-offline-label'),
  readerBtnDone: document.getElementById('reader-btn-done'),
  readerBtnDisplay: document.getElementById('reader-btn-display'),
  readerBtnDownload: document.getElementById('reader-btn-download'),
  readerDisplayBar: document.getElementById('reader-display-bar'),
  readerTypoControls: document.getElementById('reader-typo-controls'),
  readerFontDec: document.getElementById('reader-font-dec'),
  readerFontInc: document.getElementById('reader-font-inc'),
  readerFontFamily: document.getElementById('reader-font-family'),
  readerZoomControls: document.getElementById('reader-zoom-controls'),
  readerViewport: document.getElementById('reader-viewport'),
  readerLoading: document.getElementById('reader-loading'),
  readerLoadingTitle: document.getElementById('reader-loading-title'),
  readerLoadingDetail: document.getElementById('reader-loading-detail'),
  readerLoadingBar: document.getElementById('reader-loading-bar'),
  readerLoadingCancel: document.getElementById('reader-loading-cancel'),
  readerToast: document.getElementById('reader-toast'),
  readerScrubberBar: document.getElementById('reader-scrubber-bar'),
  readerPagePrev: document.getElementById('reader-page-prev'),
  readerPageRange: document.getElementById('reader-page-range'),
  readerPageLabel: document.getElementById('reader-page-label'),
  readerPageInput: document.getElementById('reader-page-input'),
  readerPageNext: document.getElementById('reader-page-next'),
};

// ── Security & Formatting Helpers ─────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isValidFileId(fileId) {
  return typeof fileId === 'string' && SAFE_DRIVE_ID_RE.test(fileId);
}

function getSafeDriveUrls(resource) {
  const idValid = isValidFileId(resource?.fileId);
  if (!idValid) {
    return { valid: false, previewUrl: '#', downloadUrl: '#', driveViewUrl: '#' };
  }

  const fallbackPreview = `https://drive.google.com/file/d/${resource.fileId}/preview`;
  const fallbackDownload = `https://drive.google.com/uc?export=download&id=${resource.fileId}`;
  const fallbackView = `https://drive.google.com/file/d/${resource.fileId}/view`;

  const previewUrl = SAFE_DRIVE_URL_RE.test(resource.previewUrl || '') ? resource.previewUrl : fallbackPreview;
  const downloadUrl = SAFE_DRIVE_URL_RE.test(resource.downloadUrl || '') ? resource.downloadUrl : fallbackDownload;
  const driveViewUrl = SAFE_DRIVE_URL_RE.test(resource.driveViewUrl || '') ? resource.driveViewUrl : fallbackView;

  return { valid: true, previewUrl, downloadUrl, driveViewUrl };
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function cleanDisplayFileName(fileName, fallbackTitle) {
  const raw = String(fileName || fallbackTitle || 'Untitled File').trim();
  return raw.replace(/[_]+/g, ' ').replace(/\s+/g, ' ');
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function showAppToast(message) {
  if (!dom.appToast) return;
  dom.appToast.textContent = message;
  dom.appToast.classList.remove('hidden');
  clearTimeout(state.appToastTimer);
  state.appToastTimer = setTimeout(() => {
    dom.appToast.classList.add('hidden');
  }, 3200);
}

function syncDialogLockClass() {
  const anyOpen = Boolean(document.querySelector('dialog[open]'));
  document.documentElement.classList.toggle('dialog-open-lock', anyOpen);
  document.body.style.overflow = anyOpen ? 'hidden' : '';
}

// ── Reader Controller Initialization ──────────────────────────────────────────

const readerController = new window.FocitReader.DocumentReaderController({
  dom: {
    dialog: dom.readerDialog,
    btnClose: dom.readerClose,
    courseCode: dom.readerCourseCode,
    fileExt: dom.readerFileExt,
    title: dom.readerTitle,
    btnSaveOffline: dom.readerBtnOffline,
    saveOfflineLabel: dom.readerOfflineLabel,
    btnMarkDone: dom.readerBtnDone,
    btnDisplay: dom.readerBtnDisplay,
    displayBar: dom.readerDisplayBar,
    btnDownload: dom.readerBtnDownload,
    typoControls: dom.readerTypoControls,
    zoomControls: dom.readerZoomControls,
    viewport: dom.readerViewport,
    loadingOverlay: dom.readerLoading,
    loadingTitle: dom.readerLoadingTitle,
    loadingDetail: dom.readerLoadingDetail,
    loadingBar: dom.readerLoadingBar,
    toast: dom.readerToast,
    scrubberBar: dom.readerScrubberBar,
    pageRange: dom.readerPageRange,
    pageLabel: dom.readerPageLabel,
    pageInput: dom.readerPageInput,
  },
  getVersionTag: () => window.FocitStorage.computeVersionTag(readerController.currentResource),
  onProgressUpdated: () => patchProgressAndOfflineUI(),
  onOfflineUpdated: async () => {
    state.offlineFileIds = await window.FocitStorage.OfflineBlobCache.listIds();
    patchProgressAndOfflineUI();
  },
  onCloseSyncUrl: () => clearDocFromUrl(),
});

// ── Web Worker & Resilient Loader ─────────────────────────────────────────────

let worker = null;

function createWorker() {
  if (worker) {
    try { worker.terminate(); } catch (_) { }
  }

  try {
    worker = new Worker('assets/search.worker.js?v=2026.4');
  } catch (err) {
    console.error('[App] Failed to construct Worker:', err);
    loadManifestDirectly();
    return;
  }

  worker.onmessage = (e) => {
    const payload = e.data || {};

    if (payload.type === 'READY') {
      handleIndexReady(Array.isArray(payload.resources) ? payload.resources : []);
      return;
    }

    if (payload.type === 'RESULTS') {
      if (payload.requestId !== state.latestSearchRequestId) {
        return;
      }
      state.searchResults = Array.isArray(payload.results) ? payload.results : [];
      state.visibleLimit = PAGE_SIZE;
      renderResults();
      return;
    }

    if (payload.type === 'ERROR') {
      console.error('[App] Worker error:', payload.message);
      handleLoadError(payload.message || 'Search index failed to load.');
    }
  };

  worker.onerror = (err) => {
    console.error('[App] Worker uncaught error:', err);
    handleLoadError('Search worker failed to initialize.');
  };

  worker.postMessage({ type: 'INIT' });
}

async function loadManifestDirectly() {
  updateStatus('loading', 'Loading repository fallback…');
  try {
    const res = await fetch('/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Invalid manifest format');
    handleIndexReady(data);
  } catch (err) {
    handleLoadError(`Could not load resources (${err.message}).`);
  }
}

function handleIndexReady(resources) {
  state.allResources = resources;
  state.resourceById = new Map();
  for (const r of resources) {
    if (r && r.id) {
      state.resourceById.set(r.id, r);
    }
  }
  state.indexReady = true;
  state.hasError = false;

  dom.headerTotalBadge.textContent = `${resources.length} files`;
  updateStatus('ready', 'Repository ready');

  buildYearOptions();
  syncFilterControlsUI();
  renderContinueReadingShelf();

  if (state.query.trim()) {
    dispatchSearchImmediate(state.query);
  } else {
    renderResults();
  }

  // Hydrate offline badges asynchronously without blocking initial render
  window.FocitStorage.OfflineBlobCache.listIds()
    .then((ids) => {
      state.offlineFileIds = ids;
      patchProgressAndOfflineUI();
    })
    .catch(() => {});

  // Cold-boot ?doc={resourceId} deep-link resolution (Contract #3 + M-2 Android back guard)
  if (state.pendingDocId) {
    const targetDocId = state.pendingDocId;
    state.pendingDocId = '';
    const target = state.resourceById.get(targetDocId);
    if (target) {
      if (!window.history.state?.readerOpened) {
        clearDocFromUrl();
        readerController.open(target, { skipHistoryPush: false });
      } else {
        readerController.open(target, { skipHistoryPush: true });
      }
    } else {
      clearDocFromUrl();
      showAppToast('Requested document link is unavailable or has moved.');
    }
  }
}

function handleLoadError(message) {
  state.hasError = true;
  state.indexReady = false;
  dom.headerTotalBadge.textContent = 'Offline';
  dom.resultCount.textContent = '';
  dom.paginationBar.classList.add('hidden');
  updateStatus('error', 'Failed to load repository');

  dom.resultsGrid.innerHTML = `
    <div class="state-panel is-error" role="alert">
      <div class="state-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      </div>
      <p class="state-title">Unable to load course repository</p>
      <p class="state-sub">${escHtml(message)} Check your connection and retry.</p>
      <button type="button" id="btn-retry-load" class="btn-state-action">Retry loading</button>
    </div>
  `;
}

// ── URL State & Saved Preference Persistence ──────────────────────────────────

function readStateFromUrlOrStorage() {
  const params = new URLSearchParams(window.location.search);
  const hasFilterParams = ['dept', 'level', 'sem', 'type', 'year', 'q'].some((k) => params.has(k));
  state.pendingDocId = params.get('doc') || '';

  if (hasFilterParams) {
    state.filters.dept = params.get('dept') || '';
    state.filters.level = params.get('level') || '';
    state.filters.sem = params.get('sem') || '';
    state.filters.type = params.get('type') || '';
    state.filters.year = params.get('year') || '';
    state.query = params.get('q') || '';
    state.usingSavedPrefs = false;
  } else {
    state.filters = { dept: '', level: '', sem: '', type: '', year: '' };
    state.query = '';
    try {
      const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      state.filters.dept = typeof saved.dept === 'string' ? saved.dept : '';
      state.filters.level = typeof saved.level === 'string' ? saved.level : '';
      state.usingSavedPrefs = Boolean(state.filters.dept || state.filters.level);
    } catch (_) {
      state.usingSavedPrefs = false;
    }
  }

  dom.searchInput.value = state.query;
  updateSearchDecorators();
}

function buildFilterSearchParams(includeDocFromCurrentUrl = true) {
  const params = new URLSearchParams();
  if (state.filters.dept) params.set('dept', state.filters.dept);
  if (state.filters.level) params.set('level', state.filters.level);
  if (state.filters.sem) params.set('sem', state.filters.sem);
  if (state.filters.type) params.set('type', state.filters.type);
  if (state.filters.year) params.set('year', state.filters.year);
  if (state.query.trim()) params.set('q', state.query.trim());

  if (includeDocFromCurrentUrl) {
    const currDoc = new URLSearchParams(window.location.search).get('doc');
    if (currDoc) params.set('doc', currDoc);
  }
  return params;
}

function syncUrlAndPrefs() {
  const params = buildFilterSearchParams(true);
  const qs = params.toString();
  const targetUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  try {
    window.history.replaceState(window.history.state, '', targetUrl);
  } catch (_) { }

  try {
    if (state.filters.dept || state.filters.level) {
      localStorage.setItem(PREF_KEY, JSON.stringify({
        dept: state.filters.dept,
        level: state.filters.level,
      }));
    } else {
      localStorage.removeItem(PREF_KEY);
    }
  } catch (_) { }
}

function clearDocFromUrl() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('doc')) return;
  params.delete('doc');
  const qs = params.toString();
  const targetUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  try {
    window.history.replaceState(null, '', targetUrl);
  } catch (_) { }
}

// ── Status, Dropdown & Mobile Chip UI Sync ────────────────────────────────────

function updateStatus(dotState, text) {
  dom.statusText.textContent = text;
  dom.statusDot.className = `status-dot ${dotState}`;
}

function updateSearchDecorators() {
  const hasText = dom.searchInput.value.length > 0;
  dom.searchClear.classList.toggle('hidden', !hasText);
  dom.searchKbd.classList.toggle('hidden', hasText);
}

function syncSelectPair(desktopEl, sheetEl, value) {
  for (const selectEl of [desktopEl, sheetEl]) {
    if (!selectEl) continue;
    const hasOption = [...selectEl.options].some((opt) => opt.value === value);
    selectEl.value = hasOption ? value : '';
    selectEl.classList.toggle('is-filtered', Boolean(selectEl.value));
  }
}

function syncFilterControlsUI() {
  syncSelectPair(dom.filterDept, dom.sheetDept, state.filters.dept);
  syncSelectPair(dom.filterLevel, dom.sheetLevel, state.filters.level);
  syncSelectPair(dom.filterSem, dom.sheetSem, state.filters.sem);
  syncSelectPair(dom.filterType, dom.sheetType, state.filters.type);
  syncSelectPair(dom.filterYear, dom.sheetYear, state.filters.year);

  const activeFilterCount = Object.values(state.filters).filter(Boolean).length;
  const anyActive = Boolean(state.query.trim()) || activeFilterCount > 0;
  dom.btnResetFilters.classList.toggle('hidden', !anyActive);

  // Mobile quick chips & filter counter badge
  if (dom.mobileFilterBadge) {
    dom.mobileFilterBadge.textContent = String(activeFilterCount);
    dom.mobileFilterBadge.classList.toggle('hidden', activeFilterCount === 0);
  }
  dom.btnOpenFilterSheet?.classList.toggle('is-active', activeFilterCount > 0);

  if (dom.mobileChipBar) {
    dom.mobileChipBar.querySelectorAll('[data-quick-level]').forEach((btn) => {
      const active = state.filters.level === btn.dataset.quickLevel;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    dom.mobileChipBar.querySelectorAll('[data-quick-sem]').forEach((btn) => {
      const active = state.filters.sem === btn.dataset.quickSem;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  // Show non-blocking personal default badge if loaded from saved localStorage prefs
  if (state.usingSavedPrefs && (state.filters.dept || state.filters.level)) {
    const parts = [];
    if (state.filters.dept) parts.push(state.filters.dept);
    if (state.filters.level) parts.push(`${state.filters.level}L`);
    dom.savedPrefsNotice.innerHTML = `Showing saved: <strong>${escHtml(parts.join(' · '))}</strong> <button type="button" id="btn-show-all-prefs" class="btn-show-all">Show All</button>`;
    dom.savedPrefsNotice.classList.remove('hidden');
  } else {
    dom.savedPrefsNotice.classList.add('hidden');
    dom.savedPrefsNotice.textContent = '';
  }
}

function buildYearOptions() {
  const minValidYear = 2018;
  const maxValidYear = new Date().getFullYear() + 1;

  const years = [...new Set(
    state.allResources
      .map((r) => Number(r.year))
      .filter((y) => Number.isInteger(y) && y >= minValidYear && y <= maxValidYear)
  )].sort((a, b) => b - a);

  for (const selectEl of [dom.filterYear, dom.sheetYear]) {
    if (!selectEl) continue;
    selectEl.querySelectorAll('option:not([value=""])').forEach((opt) => opt.remove());
    for (const year of years) {
      const opt = document.createElement('option');
      opt.value = String(year);
      opt.textContent = String(year);
      selectEl.appendChild(opt);
    }
    selectEl.disabled = years.length === 0;
  }
}

// ── Filtering & Search Dispatch ───────────────────────────────────────────────

function matchesDepartment(resource, selectedDept) {
  if (!selectedDept) return true;
  if (resource.department === selectedDept) return true;
  if (Array.isArray(resource.departments)) {
    if (resource.departments.includes('ALL') || resource.departments.includes(selectedDept)) {
      return true;
    }
  }
  const prefix = String(resource.courseCode || '').split(/\s+/)[0].toUpperCase();
  return SHARED_COURSE_PREFIXES.has(prefix);
}

function applyFilters(resources) {
  return resources.filter((r) => {
    if (!matchesDepartment(r, state.filters.dept)) return false;
    if (state.filters.level && Number(r.level) !== Number(state.filters.level)) return false;
    if (state.filters.sem && Number(r.semester) !== Number(state.filters.sem)) return false;
    if (state.filters.type && r.type !== state.filters.type) return false;
    if (state.filters.year && Number(r.year) !== Number(state.filters.year)) return false;
    return true;
  });
}

function dispatchSearchImmediate(query) {
  const trimmed = String(query || '').trim();
  state.latestSearchRequestId += 1;
  const requestId = state.latestSearchRequestId;

  if (!state.indexReady) return;

  if (!trimmed) {
    state.searchResults = null;
    state.visibleLimit = PAGE_SIZE;
    renderResults();
    return;
  }

  if (worker) {
    worker.postMessage({ type: 'SEARCH', query: trimmed, requestId });
  } else {
    const q = trimmed.toLowerCase();
    state.searchResults = state.allResources
      .filter((r) =>
        String(r.courseCode || '').toLowerCase().includes(q) ||
        String(r.courseTitle || '').toLowerCase().includes(q) ||
        String(r.fileName || '').toLowerCase().includes(q) ||
        (Array.isArray(r.aliases) && r.aliases.some((a) => a.toLowerCase().includes(q)))
      )
      .map((item) => ({ item }));
    state.visibleLimit = PAGE_SIZE;
    renderResults();
  }
}

const dispatchSearch = debounce((query) => {
  dispatchSearchImmediate(query);
}, 180);

// ── Progress Formatting & Continue Reading Shelf ──────────────────────────────

function formatProgressLabel(prog) {
  if (!prog) return '';
  if (prog.completed) return 'Completed';
  if (prog.unit === 'page') {
    return `Pg ${prog.current}/${prog.total} · ${prog.percent}%`;
  }
  if (prog.unit === 'percent' && prog.percent > 0) {
    return `${prog.percent}% read`;
  }
  return '';
}

function renderContinueReadingShelf() {
  if (!dom.continueSection || !dom.continueList || !state.indexReady) return;

  const recent = window.FocitStorage.ProgressStore.getRecent(4)
    .filter((entry) => state.resourceById.has(entry.resourceId));

  if (recent.length === 0) {
    dom.continueSection.classList.add('hidden');
    dom.continueList.innerHTML = '';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const entry of recent) {
    const resource = state.resourceById.get(entry.resourceId);
    const ext = String(resource.fileExt || entry.fileExt || 'PDF').toUpperCase();
    const extClass = EXT_CLASS[ext] || '';
    const isOffline = state.offlineFileIds.has(resource.fileId);
    const displayName = cleanDisplayFileName(resource.fileName, resource.courseTitle);
    const label = entry.completed
      ? 'Completed'
      : (entry.unit === 'page' ? `Resume Pg ${entry.current}` : `${entry.percent}% read`);

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'continue-card';
    card.dataset.continueDocId = resource.id;
    card.innerHTML = `
      <div class="continue-card-top">
        <span class="course-code">${escHtml(resource.courseCode || 'GENERAL')}</span>
        <span class="ext-badge ${escHtml(extClass)}">${escHtml(ext)}</span>
        ${isOffline ? '<span class="offline-badge">Offline</span>' : ''}
      </div>
      <span class="continue-card-title">${escHtml(displayName)}</span>
      <div class="continue-card-foot">
        <span class="continue-card-progress">${escHtml(label)}</span>
        <span class="continue-card-cta">${entry.completed ? 'Review' : 'Resume'} →</span>
      </div>
      <div class="row-progress-track" aria-hidden="true">
        <div class="row-progress-fill${entry.completed ? ' is-done' : ''}" style="width: ${entry.completed ? 100 : Math.max(4, entry.percent)}%"></div>
      </div>
    `;
    frag.appendChild(card);
  }

  dom.continueList.innerHTML = '';
  dom.continueList.appendChild(frag);
  dom.continueSection.classList.remove('hidden');
}

// ── Course Grouping, Sorting & In-Place DOM Patching ──────────────────────────

function sortCourseItems(items) {
  return [...items].sort((a, b) => {
    const typeA = TYPE_SORT_ORDER[a.type] || 99;
    const typeB = TYPE_SORT_ORDER[b.type] || 99;
    if (typeA !== typeB) return typeA - typeB;

    const yearA = Number(a.year) || 0;
    const yearB = Number(b.year) || 0;
    if (yearB !== yearA) return yearB - yearA;

    return String(a.fileName || '').localeCompare(String(b.fileName || ''));
  });
}

function groupResourcesByCourse(items, hasActiveQuery) {
  const groupMap = new Map();

  for (const r of items) {
    const rawCode = String(r.courseCode || '').trim().toUpperCase();
    const isGeneral = !rawCode || rawCode === 'GENERAL' || rawCode === 'UNKNOWN';
    const groupKey = isGeneral ? 'GENERAL' : rawCode;

    if (!groupMap.has(groupKey)) {
      const isShared = Array.isArray(r.departments) && r.departments.includes('ALL');
      const deptText = isShared ? 'Faculty-wide' : (r.department || 'General');
      const levelNum = Number.isFinite(Number(r.level)) ? Number(r.level) : null;
      const semText = r.semester === 1 ? '1st Sem' : r.semester === 2 ? '2nd Sem' : null;
      const metaParts = [deptText, levelNum ? `${levelNum}L` : null, semText].filter(Boolean);

      groupMap.set(groupKey, {
        key: groupKey,
        isGeneral,
        level: levelNum,
        courseCode: isGeneral ? 'GENERAL' : r.courseCode,
        title: isGeneral ? 'Faculty & General Resources' : (r.courseTitle || r.courseCode),
        meta: metaParts.join(' · '),
        items: [],
      });
    }

    const group = groupMap.get(groupKey);
    group.items.push(r);

    if (!group.isGeneral && group.title === group.courseCode && r.courseTitle && r.courseTitle !== r.courseCode) {
      group.title = r.courseTitle;
    }
    if (!group.level && Number.isFinite(Number(r.level))) {
      group.level = Number(r.level);
    }
  }

  const namedGroups = [];
  let generalGroup = null;

  for (const group of groupMap.values()) {
    group.items = sortCourseItems(group.items);
    if (group.isGeneral) {
      generalGroup = group;
    } else {
      namedGroups.push(group);
    }
  }

  if (!hasActiveQuery) {
    namedGroups.sort((a, b) => {
      const lvlA = a.level || 9999;
      const lvlB = b.level || 9999;
      if (lvlA !== lvlB) return lvlA - lvlB;
      return a.courseCode.localeCompare(b.courseCode);
    });
  }

  if (generalGroup) {
    namedGroups.push(generalGroup);
  }

  return namedGroups;
}

function getGroupProgressStats(items, progressMap) {
  let readCount = 0;
  for (const item of items) {
    const p = progressMap[item.id];
    if (p && (p.completed || p.percent > 0 || (p.unit === 'page' && p.current > 1))) {
      readCount += 1;
    }
  }
  return { readCount, totalCount: items.length };
}

function applyCourseCategoryVisibility(groupEl, selectedType) {
  groupEl.querySelectorAll('.resource-row').forEach((row) => {
    const match = !selectedType || row.dataset.resourceType === selectedType;
    row.classList.toggle('hidden', !match);
  });
  groupEl.querySelectorAll('.course-type-pill').forEach((pill) => {
    const active = pill.dataset.courseTab === selectedType;
    pill.classList.toggle('is-active', active);
    pill.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function renderResults() {
  if (!state.indexReady) return;

  const hasQuery = state.query.trim().length > 0;
  const source = state.searchResults !== null
    ? state.searchResults.map((r) => r.item)
    : state.allResources;

  const filtered = applyFilters(source);

  if (filtered.length === 0) {
    dom.resultCount.textContent = '0 files';
    dom.paginationBar.classList.add('hidden');
    state.renderedGroupItems.clear();
    dom.resultsGrid.innerHTML = buildEmptyState();
    return;
  }

  const visibleSlice = filtered.slice(0, state.visibleLimit);
  const groups = groupResourcesByCourse(visibleSlice, hasQuery);
  const progressMap = window.FocitStorage.ProgressStore.getAllMap();

  dom.resultCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'file' : 'files'} in ${groups.length} ${groups.length === 1 ? 'course' : 'courses'}`;

  const distinctLevels = new Set(groups.map((g) => (g.isGeneral ? 'GENERAL' : (g.level || 'OTHER'))));
  const showLevelDividers = !hasQuery && distinctLevels.size > 1;

  const fragment = document.createDocumentFragment();
  const expandAll = hasQuery || groups.length <= 2;
  state.renderedGroupItems.clear();

  let lastLevelKey = null;
  groups.forEach((group, idx) => {
    if (showLevelDividers) {
      const levelKey = group.isGeneral ? 'GENERAL' : (group.level ? `${group.level}` : 'OTHER');
      if (levelKey !== lastLevelKey) {
        lastLevelKey = levelKey;
        const levelCourses = groups.filter((g) => {
          const k = g.isGeneral ? 'GENERAL' : (g.level ? `${g.level}` : 'OTHER');
          return k === levelKey;
        });
        const divider = document.createElement('div');
        divider.className = 'level-divider';
        const title = levelKey === 'GENERAL'
          ? 'Faculty-Wide & Uncategorized'
          : (levelKey === 'OTHER' ? 'Other Courses' : `${levelKey} Level`);
        divider.innerHTML = `
          <span class="level-divider-title">${escHtml(title)}</span>
          <span class="level-divider-count">${levelCourses.length} ${levelCourses.length === 1 ? 'course' : 'courses'}</span>
        `;
        fragment.appendChild(divider);
      }
    }

    const isOpen =
      state.openCourseKeys.has(group.key) ||
      (!state.closedCourseKeys.has(group.key) && (expandAll || idx === 0));
    state.renderedGroupItems.set(group.key, group.items);
    fragment.appendChild(buildCourseGroup(group, isOpen, progressMap));
  });

  dom.resultsGrid.innerHTML = '';
  dom.resultsGrid.appendChild(fragment);

  const remaining = filtered.length - visibleSlice.length;
  if (remaining > 0) {
    dom.paginationBar.classList.remove('hidden');
    dom.btnLoadMore.textContent = `Show more (${remaining} remaining)`;
  } else {
    dom.paginationBar.classList.add('hidden');
  }
}

function buildCourseGroup(group, isOpen, progressMap) {
  const details = document.createElement('details');
  details.className = 'course-group';
  details.dataset.groupKey = group.key;
  if (isOpen) {
    details.setAttribute('open', '');
  }

  const { readCount, totalCount } = getGroupProgressStats(group.items, progressMap);
  const countLabel = `${totalCount} ${totalCount === 1 ? 'file' : 'files'}`;

  const summary = document.createElement('summary');
  summary.className = 'course-group-header';
  summary.innerHTML = `
    <div class="course-group-title-wrap">
      <span class="course-code">${escHtml(group.courseCode)}</span>
      <span class="course-group-heading">${escHtml(group.title)}</span>
      ${group.meta ? `<span class="course-group-meta">${escHtml(group.meta)}</span>` : ''}
    </div>
    <div class="course-group-right">
      <span class="group-progress-pill${readCount === 0 ? ' hidden' : ''}" data-group-progress>${readCount}/${totalCount} read</span>
      <span class="group-count-badge">${escHtml(countLabel)}</span>
      <svg class="group-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
  `;

  const body = document.createElement('div');
  body.className = 'course-group-body';

  // In-course category pills when group contains >= 2 resource types
  const typeCounts = new Map();
  for (const item of group.items) {
    const t = item.type || 'Resource';
    typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
  }

  const activeTab = state.courseCategoryTab.get(group.key) || '';
  if (typeCounts.size >= 2) {
    const tabBar = document.createElement('div');
    tabBar.className = 'course-type-pills';
    tabBar.setAttribute('role', 'tablist');
    tabBar.setAttribute('aria-label', `Filter ${group.courseCode} by resource type`);

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = `course-type-pill${activeTab === '' ? ' is-active' : ''}`;
    allBtn.dataset.courseTab = '';
    allBtn.setAttribute('role', 'tab');
    allBtn.setAttribute('aria-selected', activeTab === '' ? 'true' : 'false');
    allBtn.textContent = `All (${group.items.length})`;
    tabBar.appendChild(allBtn);

    const sortedTypes = [...typeCounts.entries()].sort(
      (a, b) => (TYPE_SORT_ORDER[a[0]] || 99) - (TYPE_SORT_ORDER[b[0]] || 99)
    );
    for (const [typeName, count] of sortedTypes) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `course-type-pill${activeTab === typeName ? ' is-active' : ''}`;
      pill.dataset.courseTab = typeName;
      pill.setAttribute('role', 'tab');
      pill.setAttribute('aria-selected', activeTab === typeName ? 'true' : 'false');
      pill.textContent = `${typeName} (${count})`;
      tabBar.appendChild(pill);
    }

    body.appendChild(tabBar);
  }

  for (const item of group.items) {
    body.appendChild(buildResourceRow(item, progressMap[item.id]));
  }

  details.appendChild(summary);
  details.appendChild(body);

  if (activeTab && typeCounts.has(activeTab)) {
    applyCourseCategoryVisibility(details, activeTab);
  }

  return details;
}

function buildRowMetaBadgesHtml(r, prog, isOffline) {
  const typeClass = TYPE_CLASS[r.type] ?? 'resource';
  const isShared = Array.isArray(r.departments) && r.departments.includes('ALL');
  const sizeLabel = formatBytes(r.fileSize);
  const semLabel = r.semester === 1 ? 'Sem 1' : r.semester === 2 ? 'Sem 2' : null;
  const levelLabel = r.level ? `${r.level}L` : null;
  const metaParts = [levelLabel, semLabel, r.year ? String(r.year) : null, sizeLabel].filter(Boolean);
  const progLabel = formatProgressLabel(prog);

  return `
    <span class="type-badge ${escHtml(typeClass)}">${escHtml(r.type || 'Resource')}</span>
    ${isShared ? '<span class="shared-badge">Shared</span>' : ''}
    ${isOffline ? '<span class="offline-badge">Offline</span>' : ''}
    ${progLabel ? `<span class="progress-badge${prog?.completed ? ' is-done' : ''}">${escHtml(progLabel)}</span>` : ''}
    ${metaParts.length > 0 ? `<span class="meta-chip-mono">${metaParts.map(escHtml).join(' <span class="meta-sep">·</span> ')}</span>` : ''}
  `;
}

function buildResourceRow(r, prog) {
  const urls = getSafeDriveUrls(r);
  const fileExt = String(r.fileExt || 'PDF').toUpperCase();
  const extClass = EXT_CLASS[fileExt] || '';
  const displayFileName = cleanDisplayFileName(r.fileName, r.courseTitle || r.courseCode);
  const isOffline = state.offlineFileIds.has(r.fileId);
  const isDone = Boolean(prog?.completed);
  const hasProgress = Boolean(prog && (prog.completed || prog.percent > 0 || (prog.unit === 'page' && prog.current > 1)));
  const readBtnLabel = isDone ? 'Review' : (hasProgress ? 'Resume' : 'Read');

  const row = document.createElement('article');
  row.className = 'resource-row';
  row.dataset.resourceId = r.id;
  row.dataset.fileId = r.fileId;
  row.dataset.resourceType = r.type || 'Resource';
  row.setAttribute('aria-label', `${r.courseCode || 'Resource'} — ${displayFileName}`);

  // Contract #4: Valid non-nested interactive markup. Main button contains only phrasing spans.
  row.innerHTML = `
    <button
      type="button"
      class="row-main-btn"
      data-action="read"
      data-resource-id="${escHtml(r.id)}"
      ${urls.valid ? '' : 'disabled'}
    >
      <span class="row-file-line">
        <span class="ext-badge ${escHtml(extClass)}">${escHtml(fileExt)}</span>
        <span class="row-filename-title" title="${escHtml(r.fileName || displayFileName)}">${escHtml(displayFileName)}</span>
      </span>
      <span class="row-sub" data-row-sub>
        ${buildRowMetaBadgesHtml(r, prog, isOffline)}
      </span>
      <span class="row-progress-track${hasProgress ? '' : ' hidden'}" data-row-progress-track aria-hidden="true">
        <span class="row-progress-fill${isDone ? ' is-done' : ''}" data-row-progress-fill style="width: ${isDone ? 100 : (prog?.percent || 0)}%"></span>
      </span>
    </button>
    <div class="row-actions">
      <button
        type="button"
        class="btn-read"
        data-action="read"
        data-resource-id="${escHtml(r.id)}"
        ${urls.valid ? '' : 'disabled'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        <span data-read-label>${escHtml(readBtnLabel)}</span>
      </button>
      <button
        type="button"
        class="btn-row-icon${isDone ? ' is-done' : ''}"
        data-action="toggle-done"
        data-resource-id="${escHtml(r.id)}"
        aria-label="${isDone ? 'Mark as unread' : 'Mark as completed'}"
        aria-pressed="${isDone ? 'true' : 'false'}"
        title="${isDone ? 'Completed' : 'Mark as completed'}"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
      </button>
      <a
        class="btn-row-icon${urls.valid ? '' : ' disabled'}"
        href="${escHtml(urls.downloadUrl)}"
        target="_blank"
        rel="noopener noreferrer"
        data-action="download"
        aria-label="Download ${escHtml(displayFileName)}"
        title="Download file"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </a>
    </div>
  `;

  return row;
}

/**
 * Contract #3: In-place DOM patching after progress/offline updates.
 * Preserves open accordions, active category tabs, and scroll position.
 */
function patchProgressAndOfflineUI() {
  renderContinueReadingShelf();

  const progressMap = window.FocitStorage.ProgressStore.getAllMap();

  dom.resultsGrid.querySelectorAll('.resource-row[data-resource-id]').forEach((row) => {
    const resourceId = row.dataset.resourceId;
    const resource = state.resourceById.get(resourceId);
    if (!resource) return;

    const prog = progressMap[resourceId];
    const isOffline = state.offlineFileIds.has(resource.fileId);
    const isDone = Boolean(prog?.completed);
    const hasProgress = Boolean(prog && (prog.completed || prog.percent > 0 || (prog.unit === 'page' && prog.current > 1)));

    const subEl = row.querySelector('[data-row-sub]');
    if (subEl) {
      subEl.innerHTML = buildRowMetaBadgesHtml(resource, prog, isOffline);
    }

    const track = row.querySelector('[data-row-progress-track]');
    const fill = row.querySelector('[data-row-progress-fill]');
    if (track && fill) {
      track.classList.toggle('hidden', !hasProgress);
      fill.classList.toggle('is-done', isDone);
      fill.style.width = `${isDone ? 100 : (prog?.percent || 0)}%`;
    }

    const readLabel = row.querySelector('[data-read-label]');
    if (readLabel) {
      readLabel.textContent = isDone ? 'Review' : (hasProgress ? 'Resume' : 'Read');
    }

    const doneBtn = row.querySelector('[data-action="toggle-done"]');
    if (doneBtn) {
      doneBtn.classList.toggle('is-done', isDone);
      doneBtn.setAttribute('aria-pressed', isDone ? 'true' : 'false');
      doneBtn.setAttribute('aria-label', isDone ? 'Mark as unread' : 'Mark as completed');
    }
  });

  dom.resultsGrid.querySelectorAll('.course-group[data-group-key]').forEach((groupEl) => {
    const key = groupEl.dataset.groupKey;
    const items = state.renderedGroupItems.get(key);
    const badge = groupEl.querySelector('[data-group-progress]');
    if (!items || !badge) return;

    const { readCount, totalCount } = getGroupProgressStats(items, progressMap);
    badge.textContent = `${readCount}/${totalCount} read`;
    badge.classList.toggle('hidden', readCount === 0);
  });
}

function buildEmptyState() {
  const trimmedQuery = state.query.trim();
  const hasFilters = Object.values(state.filters).some(Boolean);

  const contextPieces = [];
  if (state.filters.dept) contextPieces.push(state.filters.dept);
  if (state.filters.level) contextPieces.push(`${state.filters.level}L`);
  if (state.filters.sem) contextPieces.push(`Semester ${state.filters.sem}`);
  if (state.filters.type) contextPieces.push(state.filters.type);
  if (state.filters.year) contextPieces.push(state.filters.year);

  const title = trimmedQuery
    ? `No matches for "${escHtml(trimmedQuery)}"`
    : 'No materials uploaded for this selection yet';

  const subtitle = trimmedQuery
    ? 'Try searching by course code (e.g. CSC 202 or COS 204), filename, or clear active filters.'
    : contextPieces.length > 0
      ? `No files are currently indexed under ${escHtml(contextPieces.join(' · '))}. New Drive uploads appear automatically after the daily sync.`
      : 'No files are currently in the repository.';

  return `
    <div class="state-panel">
      <div class="state-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      </div>
      <p class="state-title">${title}</p>
      <p class="state-sub">${subtitle}</p>
      ${(trimmedQuery || hasFilters)
      ? '<button type="button" id="btn-clear-filters" class="btn-state-action">Reset all filters</button>'
      : ''}
    </div>
  `;
}

// ── Filter Actions & Bottom Sheet ─────────────────────────────────────────────

function applyFilterMutation(filterKey, value) {
  state.filters[filterKey] = value;
  state.usingSavedPrefs = false;
  state.visibleLimit = PAGE_SIZE;

  syncFilterControlsUI();
  syncUrlAndPrefs();
  renderResults();
}

function clearAllFilters() {
  state.filters = { dept: '', level: '', sem: '', type: '', year: '' };
  state.query = '';
  state.usingSavedPrefs = false;
  state.searchResults = null;
  state.visibleLimit = PAGE_SIZE;
  state.latestSearchRequestId += 1;

  dom.searchInput.value = '';
  updateSearchDecorators();
  syncFilterControlsUI();
  syncUrlAndPrefs();
  renderResults();
}

function openFilterSheet() {
  if (!dom.filterSheet || dom.filterSheet.open) return;
  syncFilterControlsUI();
  dom.filterSheet.showModal();
  syncDialogLockClass();
}

function closeFilterSheet() {
  if (!dom.filterSheet || !dom.filterSheet.open) return;
  dom.filterSheet.close();
  syncDialogLockClass();
}

// ── Reader Controls Wiring ────────────────────────────────────────────────────

function syncDisplayBarUI() {
  const prefs = window.FocitStorage.ReaderPrefsStore.get();
  dom.readerDisplayBar?.querySelectorAll('[data-reader-theme-btn]').forEach((btn) => {
    const active = btn.dataset.readerThemeBtn === prefs.theme;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  dom.readerDisplayBar?.querySelectorAll('[data-reader-zoom]').forEach((btn) => {
    const active = String(prefs.zoomMode) === btn.dataset.readerZoom;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  if (dom.readerFontFamily) {
    dom.readerFontFamily.textContent = prefs.fontFamily === 'serif' ? 'Sans' : 'Serif';
  }
}

function wireReaderEvents() {
  dom.readerClose?.addEventListener('click', () => {
    readerController.close();
    syncDialogLockClass();
  });

  dom.readerLoadingCancel?.addEventListener('click', () => {
    readerController.close();
    syncDialogLockClass();
  });

  dom.readerDialog?.addEventListener('cancel', (e) => {
    e.preventDefault();
    readerController.close();
    syncDialogLockClass();
  });

  dom.readerDialog?.addEventListener('close', () => {
    syncDialogLockClass();
  });

  dom.readerDialog?.addEventListener('click', (e) => {
    if (e.target === dom.readerDialog) {
      readerController.close();
      syncDialogLockClass();
    }
  });

  dom.readerBtnOffline?.addEventListener('click', () => {
    readerController.toggleSaveOffline();
  });

  dom.readerBtnDone?.addEventListener('click', () => {
    readerController.toggleMarkCompleted();
  });

  dom.readerBtnDisplay?.addEventListener('click', () => {
    const hidden = dom.readerDisplayBar.classList.toggle('hidden');
    dom.readerBtnDisplay.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    syncDisplayBarUI();
  });

  dom.readerDisplayBar?.addEventListener('click', (e) => {
    const themeBtn = e.target.closest('[data-reader-theme-btn]');
    if (themeBtn) {
      readerController.setTheme(themeBtn.dataset.readerThemeBtn);
      syncDisplayBarUI();
      return;
    }

    const zoomBtn = e.target.closest('[data-reader-zoom]');
    if (zoomBtn) {
      const val = zoomBtn.dataset.readerZoom;
      readerController.setZoom(val === 'fit-width' ? 'fit-width' : Number(val));
      syncDisplayBarUI();
    }
  });

  dom.readerFontDec?.addEventListener('click', () => readerController.adjustFontSize(-1));
  dom.readerFontInc?.addEventListener('click', () => readerController.adjustFontSize(1));
  dom.readerFontFamily?.addEventListener('click', () => {
    readerController.toggleFontFamily();
    syncDisplayBarUI();
  });

  // PDF Scrubber & Jump-to-Page
  dom.readerPagePrev?.addEventListener('click', () => {
    const curr = Number(dom.readerPageRange?.value || 1);
    readerController.jumpToPage(Math.max(1, curr - 1));
  });

  dom.readerPageNext?.addEventListener('click', () => {
    const curr = Number(dom.readerPageRange?.value || 1);
    const max = Number(dom.readerPageRange?.max || 1);
    readerController.jumpToPage(Math.min(max, curr + 1));
  });

  dom.readerPageRange?.addEventListener('input', (e) => {
    const page = Number(e.target.value);
    const max = Number(dom.readerPageRange?.max || 1);
    if (dom.readerPageLabel) dom.readerPageLabel.textContent = `Page ${page} / ${max}`;
    if (dom.readerPageInput) dom.readerPageInput.value = String(page);
  });

  dom.readerPageRange?.addEventListener('change', (e) => {
    readerController.jumpToPage(Number(e.target.value));
  });

  dom.readerPageInput?.addEventListener('change', (e) => {
    readerController.jumpToPage(Number(e.target.value));
  });
}

// ── Event Wiring ──────────────────────────────────────────────────────────────

function init() {
  readStateFromUrlOrStorage();
  syncFilterControlsUI();
  wireReaderEvents();

  // Desktop dropdown selects
  dom.filterBar?.addEventListener('change', (e) => {
    const select = e.target.closest('select.filter-select');
    if (!select || !select.dataset.filter) return;
    applyFilterMutation(select.dataset.filter, select.value);
  });

  // Mobile quick chip bar
  dom.mobileChipBar?.addEventListener('click', (e) => {
    if (e.target.closest('#btn-open-filter-sheet')) {
      openFilterSheet();
      return;
    }

    const levelChip = e.target.closest('[data-quick-level]');
    if (levelChip) {
      const target = levelChip.dataset.quickLevel;
      applyFilterMutation('level', state.filters.level === target ? '' : target);
      return;
    }

    const semChip = e.target.closest('[data-quick-sem]');
    if (semChip) {
      const target = semChip.dataset.quickSem;
      applyFilterMutation('sem', state.filters.sem === target ? '' : target);
    }
  });

  // Mobile bottom-sheet filter drawer
  dom.filterSheet?.addEventListener('change', (e) => {
    const select = e.target.closest('select[data-sheet-filter]');
    if (!select) return;
    applyFilterMutation(select.dataset.sheetFilter, select.value);
  });
  dom.btnSheetClose?.addEventListener('click', closeFilterSheet);
  dom.btnSheetApply?.addEventListener('click', closeFilterSheet);
  dom.btnSheetReset?.addEventListener('click', () => {
    clearAllFilters();
    closeFilterSheet();
  });
  dom.filterSheet?.addEventListener('click', (e) => {
    if (e.target === dom.filterSheet) closeFilterSheet();
  });
  dom.filterSheet?.addEventListener('close', syncDialogLockClass);

  // Continue Reading shelf clicks
  dom.continueList?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-continue-doc-id]');
    if (!card) return;
    const res = state.resourceById.get(card.dataset.continueDocId);
    if (res) {
      readerController.open(res, { triggerBtn: card });
    }
  });

  // Reset Filters button
  dom.btnResetFilters.addEventListener('click', clearAllFilters);

  // "Show All" button inside saved-preferences notice
  dom.savedPrefsNotice.addEventListener('click', (e) => {
    if (e.target.closest('#btn-show-all-prefs')) {
      clearAllFilters();
    }
  });

  // Search input
  dom.searchInput.addEventListener('input', (e) => {
    state.query = e.target.value;
    updateSearchDecorators();
    syncFilterControlsUI();
    syncUrlAndPrefs();
    dispatchSearch(state.query);
  });

  dom.searchClear.addEventListener('click', () => {
    state.query = '';
    dom.searchInput.value = '';
    updateSearchDecorators();
    syncFilterControlsUI();
    syncUrlAndPrefs();
    dispatchSearchImmediate('');
    dom.searchInput.focus();
  });

  // Track open/closed accordions so progress updates and pagination never reset them
  dom.resultsGrid.addEventListener('toggle', (e) => {
    const details = e.target;
    if (!details || !details.classList?.contains('course-group')) return;
    const key = details.dataset.groupKey;
    if (!key) return;
    if (details.open) {
      state.openCourseKeys.add(key);
      state.closedCourseKeys.delete(key);
    } else {
      state.openCourseKeys.delete(key);
      state.closedCourseKeys.add(key);
    }
  }, true);

  // Results delegated actions (Contract #4: non-nested button delegation + stopPropagation)
  dom.resultsGrid.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-course-tab]');
    if (tabBtn) {
      const groupEl = tabBtn.closest('.course-group');
      if (groupEl) {
        const selectedType = tabBtn.dataset.courseTab || '';
        state.courseCategoryTab.set(groupEl.dataset.groupKey, selectedType);
        applyCourseCategoryVisibility(groupEl, selectedType);
      }
      return;
    }

    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      const action = actionEl.dataset.action;
      if (action === 'download') {
        e.stopPropagation();
        return;
      }

      const resId = actionEl.dataset.resourceId;
      const resource = state.resourceById.get(resId);
      if (!resource) return;

      if (action === 'toggle-done') {
        e.stopPropagation();
        const curr = window.FocitStorage.ProgressStore.get(resId);
        const nextDone = !Boolean(curr?.completed);
        window.FocitStorage.ProgressStore.markCompleted(resId, nextDone, {
          fileId: resource.fileId,
          courseCode: resource.courseCode,
          title: resource.fileName || resource.courseTitle,
          fileExt: resource.fileExt,
        });
        patchProgressAndOfflineUI();
        return;
      }

      if (action === 'read') {
        readerController.open(resource, { triggerBtn: actionEl });
        return;
      }
    }

    if (e.target.closest('#btn-clear-filters')) {
      clearAllFilters();
      return;
    }

    if (e.target.closest('#btn-retry-load')) {
      updateStatus('loading', 'Retrying…');
      loadManifestDirectly();
    }
  });

  // Pagination
  dom.btnLoadMore.addEventListener('click', () => {
    state.visibleLimit += PAGE_SIZE;
    renderResults();
  });

  // Shareable URL copy button
  dom.btnCopyLink.addEventListener('click', async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      dom.btnCopyLink.classList.add('copied');
      dom.copyLinkLabel.textContent = 'Copied!';
      setTimeout(() => {
        dom.btnCopyLink.classList.remove('copied');
        dom.copyLinkLabel.textContent = 'Copy Link';
      }, 2000);
    } catch (_) {
      window.prompt('Copy this link to share:', url);
    }
  });

  // Keyboard shortcut: '/' focuses search
  document.addEventListener('keydown', (e) => {
    const anyDialogOpen = Boolean(document.querySelector('dialog[open]'));
    if (e.key === '/' && !anyDialogOpen && document.activeElement !== dom.searchInput) {
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault();
        dom.searchInput.focus();
      }
    }
  });

  // Sync browser back/forward navigation (closes reader on hardware back button)
  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    const docId = params.get('doc') || '';

    if (!docId && readerController.isOpen()) {
      readerController.close({ fromPopstate: true });
      syncDialogLockClass();
      return;
    }

    if (docId && state.indexReady) {
      const target = state.resourceById.get(docId);
      if (target) {
        if (!readerController.isOpen() || readerController.currentResource?.id !== docId) {
          readerController.open(target, { skipHistoryPush: true });
        }
        return;
      } else {
        clearDocFromUrl();
        showAppToast('Requested document link is unavailable or has moved.');
      }
    }

    readStateFromUrlOrStorage();
    syncFilterControlsUI();
    dispatchSearchImmediate(state.query);
  });

  createWorker();
}

init();
