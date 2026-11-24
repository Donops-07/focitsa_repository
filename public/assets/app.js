/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Client Application Logic
   Zero-trust client: strict escaping, URL state sync, monotonic search IDs,
   compact dropdown filters, course-grouped accordions, and full-height reader.
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
  'Tutorial':      'tutorial',
  'Syllabus':      'syllabus',
  'Textbook':      'textbook',
  'Resource':      'resource',
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
  searchResults: null,
  filters: {
    dept:  '',
    level: '',
    sem:   '',
    type:  '',
    year:  '',
  },
  query: '',
  usingSavedPrefs: false,
  visibleLimit: PAGE_SIZE,
  indexReady: false,
  hasError: false,
  latestSearchRequestId: 0,
  modalClearTimer: null,
  lastModalTrigger: null,
};

// ── DOM References ────────────────────────────────────────────────────────────

const dom = {
  headerTotalBadge: document.getElementById('header-total-badge'),
  btnCopyLink:      document.getElementById('btn-copy-link'),
  copyLinkLabel:    document.getElementById('copy-link-label'),

  searchInput:      document.getElementById('search-input'),
  searchKbd:        document.getElementById('search-kbd'),
  searchClear:      document.getElementById('search-clear'),

  filterBar:        document.querySelector('.filter-bar'),
  filterDept:       document.getElementById('filter-dept'),
  filterLevel:      document.getElementById('filter-level'),
  filterSem:        document.getElementById('filter-sem'),
  filterType:       document.getElementById('filter-type'),
  filterYear:       document.getElementById('filter-year'),
  btnResetFilters:  document.getElementById('btn-reset-filters'),

  statusDot:        document.getElementById('status-dot'),
  statusText:       document.getElementById('status-text'),
  savedPrefsNotice: document.getElementById('saved-prefs-notice'),
  resultCount:      document.getElementById('result-count'),

  resultsGrid:      document.getElementById('results-grid'),
  paginationBar:    document.getElementById('pagination-bar'),
  btnLoadMore:      document.getElementById('btn-load-more'),

  modal:            document.getElementById('preview-modal'),
  modalClose:       document.getElementById('modal-close'),
  modalCourseCode:  document.getElementById('modal-course-code'),
  modalFileExt:     document.getElementById('modal-file-ext'),
  modalTitle:       document.getElementById('modal-title'),
  modalIframe:      document.getElementById('preview-iframe'),
  modalBtnDrive:    document.getElementById('modal-btn-drive'),
  modalBtnDownload: document.getElementById('modal-btn-download'),
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

  const fallbackPreview  = `https://drive.google.com/file/d/${resource.fileId}/preview`;
  const fallbackDownload = `https://drive.google.com/uc?export=download&id=${resource.fileId}`;
  const fallbackView     = `https://drive.google.com/file/d/${resource.fileId}/view`;

  const previewUrl   = SAFE_DRIVE_URL_RE.test(resource.previewUrl || '') ? resource.previewUrl : fallbackPreview;
  const downloadUrl  = SAFE_DRIVE_URL_RE.test(resource.downloadUrl || '') ? resource.downloadUrl : fallbackDownload;
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

// ── Web Worker & Resilient Loader ─────────────────────────────────────────────

let worker = null;

function createWorker() {
  if (worker) {
    try { worker.terminate(); } catch (_) { }
  }

  try {
    worker = new Worker('assets/search.worker.js?v=2026.3');
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
  state.indexReady = true;
  state.hasError = false;

  dom.headerTotalBadge.textContent = `${resources.length} files`;
  updateStatus('ready', 'Repository ready');

  buildYearOptions();
  syncFilterControlsUI();

  if (state.query.trim()) {
    dispatchSearchImmediate(state.query);
  } else {
    renderResults();
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
  const hasUrlState = ['dept', 'level', 'sem', 'type', 'year', 'q'].some(k => params.has(k));

  if (hasUrlState) {
    state.filters.dept  = params.get('dept') || '';
    state.filters.level = params.get('level') || '';
    state.filters.sem   = params.get('sem') || '';
    state.filters.type  = params.get('type') || '';
    state.filters.year  = params.get('year') || '';
    state.query         = params.get('q') || '';
    state.usingSavedPrefs = false;
  } else {
    state.filters = { dept: '', level: '', sem: '', type: '', year: '' };
    state.query = '';
    try {
      const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      state.filters.dept  = typeof saved.dept === 'string' ? saved.dept : '';
      state.filters.level = typeof saved.level === 'string' ? saved.level : '';
      state.usingSavedPrefs = Boolean(state.filters.dept || state.filters.level);
    } catch (_) {
      state.usingSavedPrefs = false;
    }
  }

  dom.searchInput.value = state.query;
  updateSearchDecorators();
}

function syncUrlAndPrefs() {
  const params = new URLSearchParams();
  if (state.filters.dept)  params.set('dept', state.filters.dept);
  if (state.filters.level) params.set('level', state.filters.level);
  if (state.filters.sem)   params.set('sem', state.filters.sem);
  if (state.filters.type)  params.set('type', state.filters.type);
  if (state.filters.year)  params.set('year', state.filters.year);
  if (state.query.trim())  params.set('q', state.query.trim());

  const qs = params.toString();
  const targetUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  try {
    window.history.replaceState(null, '', targetUrl);
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

// ── Status & Dropdown UI Sync ─────────────────────────────────────────────────

function updateStatus(dotState, text) {
  dom.statusText.textContent = text;
  dom.statusDot.className = `status-dot ${dotState}`;
}

function updateSearchDecorators() {
  const hasText = dom.searchInput.value.length > 0;
  dom.searchClear.classList.toggle('hidden', !hasText);
  dom.searchKbd.classList.toggle('hidden', hasText);
}

function syncFilterControlsUI() {
  const controls = [
    [dom.filterDept, state.filters.dept],
    [dom.filterLevel, state.filters.level],
    [dom.filterSem, state.filters.sem],
    [dom.filterType, state.filters.type],
    [dom.filterYear, state.filters.year],
  ];

  for (const [selectEl, value] of controls) {
    if (!selectEl) continue;
    const hasOption = [...selectEl.options].some(opt => opt.value === value);
    selectEl.value = hasOption ? value : '';
    selectEl.classList.toggle('is-filtered', Boolean(selectEl.value));
  }

  const anyActive = Boolean(state.query.trim()) || Object.values(state.filters).some(Boolean);
  dom.btnResetFilters.classList.toggle('hidden', !anyActive);

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
      .map(r => Number(r.year))
      .filter(y => Number.isInteger(y) && y >= minValidYear && y <= maxValidYear)
  )].sort((a, b) => b - a);

  // Preserve "All Years" option, rebuild dynamic options
  dom.filterYear.querySelectorAll('option:not([value=""])').forEach(opt => opt.remove());

  for (const year of years) {
    const opt = document.createElement('option');
    opt.value = String(year);
    opt.textContent = String(year);
    dom.filterYear.appendChild(opt);
  }

  dom.filterYear.disabled = years.length === 0;
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
    if (state.filters.sem   && Number(r.semester) !== Number(state.filters.sem)) return false;
    if (state.filters.type  && r.type !== state.filters.type) return false;
    if (state.filters.year  && Number(r.year) !== Number(state.filters.year)) return false;
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
      .filter(r =>
        String(r.courseCode || '').toLowerCase().includes(q) ||
        String(r.courseTitle || '').toLowerCase().includes(q) ||
        String(r.fileName || '').toLowerCase().includes(q) ||
        (Array.isArray(r.aliases) && r.aliases.some(a => a.toLowerCase().includes(q)))
      )
      .map(item => ({ item }));
    state.visibleLimit = PAGE_SIZE;
    renderResults();
  }
}

const dispatchSearch = debounce((query) => {
  dispatchSearchImmediate(query);
}, 180);

// ── Course Grouping & Rendering ───────────────────────────────────────────────

function groupResourcesByCourse(items, hasActiveQuery) {
  const groupMap = new Map();

  for (const r of items) {
    const rawCode = String(r.courseCode || '').trim().toUpperCase();
    const isGeneral = !rawCode || rawCode === 'GENERAL' || rawCode === 'UNKNOWN';
    const groupKey = isGeneral ? 'GENERAL' : rawCode;

    if (!groupMap.has(groupKey)) {
      const isShared = Array.isArray(r.departments) && r.departments.includes('ALL');
      const deptText = isShared ? 'Faculty-wide' : (r.department || 'General');
      const levelText = r.level ? `${r.level}L` : null;
      const metaParts = [deptText, levelText].filter(Boolean);

      groupMap.set(groupKey, {
        key: groupKey,
        isGeneral,
        courseCode: isGeneral ? 'GENERAL' : r.courseCode,
        title: isGeneral ? 'General Resources' : (r.courseTitle || r.courseCode),
        meta: metaParts.join(' · '),
        items: [],
      });
    }

    const group = groupMap.get(groupKey);
    group.items.push(r);

    // Enrich title if first item lacked descriptive title
    if (!group.isGeneral && group.title === group.courseCode && r.courseTitle && r.courseTitle !== r.courseCode) {
      group.title = r.courseTitle;
    }
  }

  const namedGroups = [];
  let generalGroup = null;

  for (const group of groupMap.values()) {
    if (group.isGeneral) {
      generalGroup = group;
    } else {
      namedGroups.push(group);
    }
  }

  if (!hasActiveQuery) {
    namedGroups.sort((a, b) => a.courseCode.localeCompare(b.courseCode));
  }

  if (generalGroup) {
    namedGroups.push(generalGroup);
  }

  return namedGroups;
}

function renderResults() {
  if (!state.indexReady) return;

  const hasQuery = state.query.trim().length > 0;
  const source = state.searchResults !== null
    ? state.searchResults.map(r => r.item)
    : state.allResources;

  const filtered = applyFilters(source);

  if (filtered.length === 0) {
    dom.resultCount.textContent = '0 files';
    dom.paginationBar.classList.add('hidden');
    dom.resultsGrid.innerHTML = buildEmptyState();
    return;
  }

  const visibleSlice = filtered.slice(0, state.visibleLimit);
  const groups = groupResourcesByCourse(visibleSlice, hasQuery);

  dom.resultCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'file' : 'files'} in ${groups.length} ${groups.length === 1 ? 'course' : 'courses'}`;

  const fragment = document.createDocumentFragment();
  const expandAll = hasQuery || groups.length <= 3;

  groups.forEach((group, idx) => {
    const isOpen = expandAll || idx < 2;
    fragment.appendChild(buildCourseGroup(group, isOpen));
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

function buildCourseGroup(group, isOpen) {
  const details = document.createElement('details');
  details.className = 'course-group';
  if (isOpen) {
    details.setAttribute('open', '');
  }

  const fileCount = group.items.length;
  const countLabel = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;

  const summary = document.createElement('summary');
  summary.className = 'course-group-header';
  summary.innerHTML = `
    <div class="course-group-title-wrap">
      <span class="course-code">${escHtml(group.courseCode)}</span>
      <span class="course-group-heading">${escHtml(group.title)}</span>
      ${group.meta ? `<span class="course-group-meta">${escHtml(group.meta)}</span>` : ''}
    </div>
    <div class="course-group-right">
      <span class="group-count-badge">${escHtml(countLabel)}</span>
      <svg class="group-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </div>
  `;

  const body = document.createElement('div');
  body.className = 'course-group-body';

  for (const item of group.items) {
    body.appendChild(buildResourceRow(item));
  }

  details.appendChild(summary);
  details.appendChild(body);
  return details;
}

function buildResourceRow(r) {
  const typeClass = TYPE_CLASS[r.type] ?? 'resource';
  const urls = getSafeDriveUrls(r);
  const fileExt = String(r.fileExt || 'PDF').toUpperCase();
  const extClass = EXT_CLASS[fileExt] || '';
  const displayFileName = cleanDisplayFileName(r.fileName, r.courseTitle || r.courseCode);
  const isShared = Array.isArray(r.departments) && r.departments.includes('ALL');
  const sizeLabel = formatBytes(r.fileSize);
  const semLabel = r.semester === 1 ? 'Sem 1' : r.semester === 2 ? 'Sem 2' : null;
  const levelLabel = r.level ? `${r.level}L` : null;

  const metaParts = [levelLabel, semLabel, r.year ? String(r.year) : null, sizeLabel].filter(Boolean);

  const row = document.createElement('article');
  row.className = 'resource-row';
  row.setAttribute('aria-label', `${r.courseCode || 'Resource'} — ${displayFileName}`);

  row.innerHTML = `
    <div class="row-main">
      <div class="row-file-line">
        <span class="ext-badge ${escHtml(extClass)}">${escHtml(fileExt)}</span>
        <span class="row-filename-title" title="${escHtml(r.fileName || displayFileName)}">${escHtml(displayFileName)}</span>
      </div>
      <div class="row-sub">
        <span class="type-badge ${escHtml(typeClass)}">${escHtml(r.type || 'Resource')}</span>
        ${isShared ? '<span class="shared-badge">Shared</span>' : ''}
        ${metaParts.length > 0 ? `<span class="meta-chip-mono">${metaParts.map(escHtml).join(' <span class="meta-sep">·</span> ')}</span>` : ''}
      </div>
    </div>
    <div class="row-actions">
      <button
        type="button"
        class="btn-preview"
        data-preview-url="${escHtml(urls.previewUrl)}"
        data-download-url="${escHtml(urls.downloadUrl)}"
        data-drive-url="${escHtml(urls.driveViewUrl)}"
        data-course-code="${escHtml(r.courseCode || 'GENERAL')}"
        data-file-ext="${escHtml(fileExt)}"
        data-title="${escHtml(r.fileName || displayFileName)}"
        ${urls.valid ? '' : 'disabled'}
        aria-label="Preview ${escHtml(displayFileName)}"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        <span>Preview</span>
      </button>
      <a
        class="btn-open-tab${urls.valid ? '' : ' disabled'}"
        href="${escHtml(urls.driveViewUrl)}"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open ${escHtml(displayFileName)} in new browser tab"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        <span>Open in Tab</span>
      </a>
      <a
        class="btn-download${urls.valid ? '' : ' disabled'}"
        href="${escHtml(urls.downloadUrl)}"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Download ${escHtml(displayFileName)}"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span>Download</span>
      </a>
    </div>
  `;

  return row;
}

function buildEmptyState() {
  const trimmedQuery = state.query.trim();
  const hasFilters = Object.values(state.filters).some(Boolean);

  const contextPieces = [];
  if (state.filters.dept)  contextPieces.push(state.filters.dept);
  if (state.filters.level) contextPieces.push(`${state.filters.level}L`);
  if (state.filters.sem)   contextPieces.push(`Semester ${state.filters.sem}`);
  if (state.filters.type)  contextPieces.push(state.filters.type);
  if (state.filters.year)  contextPieces.push(state.filters.year);

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

// ── Full-Height Native <dialog> Reader Modal ──────────────────────────────────

function openModal(triggerBtn) {
  if (state.modalClearTimer) {
    clearTimeout(state.modalClearTimer);
    state.modalClearTimer = null;
  }

  state.lastModalTrigger = triggerBtn;

  const previewUrl  = triggerBtn.dataset.previewUrl;
  const downloadUrl = triggerBtn.dataset.downloadUrl;
  const driveUrl    = triggerBtn.dataset.driveUrl;
  const courseCode  = triggerBtn.dataset.courseCode || 'GENERAL';
  const fileExt     = (triggerBtn.dataset.fileExt || 'PDF').toUpperCase();
  const title       = triggerBtn.dataset.title || 'Document Preview';

  if (!SAFE_DRIVE_URL_RE.test(previewUrl || '')) return;

  dom.modalCourseCode.textContent = courseCode;
  dom.modalFileExt.textContent = fileExt;
  dom.modalFileExt.className = `ext-badge ${EXT_CLASS[fileExt] || ''}`;
  dom.modalTitle.textContent = title;
  dom.modalTitle.title = title;

  dom.modalIframe.src = previewUrl;
  dom.modalBtnDownload.href = SAFE_DRIVE_URL_RE.test(downloadUrl || '') ? downloadUrl : '#';
  dom.modalBtnDrive.href = SAFE_DRIVE_URL_RE.test(driveUrl || '') ? driveUrl : '#';

  document.body.style.overflow = 'hidden';
  if (!dom.modal.open) {
    dom.modal.showModal();
  }
  dom.modalClose.focus();
}

function closeModal() {
  if (dom.modal.open) {
    dom.modal.close();
  }
}

// ── Filter Actions ────────────────────────────────────────────────────────────

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

// ── Event Wiring ──────────────────────────────────────────────────────────────

function init() {
  readStateFromUrlOrStorage();
  syncFilterControlsUI();

  // Delegated change handler for all dropdown selects
  dom.filterBar.addEventListener('change', (e) => {
    const select = e.target.closest('select.filter-select');
    if (!select) return;

    const filterKey = select.dataset.filter;
    if (!filterKey) return;

    state.filters[filterKey] = select.value;
    state.usingSavedPrefs = false;
    state.visibleLimit = PAGE_SIZE;

    syncFilterControlsUI();
    syncUrlAndPrefs();
    renderResults();
  });

  // Reset Filters button inside filter bar
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

  // Clear search
  dom.searchClear.addEventListener('click', () => {
    state.query = '';
    dom.searchInput.value = '';
    updateSearchDecorators();
    syncFilterControlsUI();
    syncUrlAndPrefs();
    dispatchSearchImmediate('');
    dom.searchInput.focus();
  });

  // Results delegated actions (Preview, Clear filters, Retry)
  dom.resultsGrid.addEventListener('click', (e) => {
    const previewBtn = e.target.closest('.btn-preview');
    if (previewBtn) {
      openModal(previewBtn);
      return;
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

  // Native <dialog> reader modal events
  dom.modalClose.addEventListener('click', closeModal);
  dom.modal.addEventListener('click', (e) => {
    if (e.target === dom.modal) closeModal();
  });
  dom.modal.addEventListener('close', () => {
    document.body.style.overflow = '';
    state.modalClearTimer = setTimeout(() => {
      dom.modalIframe.src = '';
    }, 250);
    if (state.lastModalTrigger && typeof state.lastModalTrigger.focus === 'function') {
      state.lastModalTrigger.focus();
    }
  });

  // Keyboard shortcut: '/' focuses search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !dom.modal.open && document.activeElement !== dom.searchInput) {
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault();
        dom.searchInput.focus();
      }
    }
  });

  // Sync browser back/forward navigation
  window.addEventListener('popstate', () => {
    readStateFromUrlOrStorage();
    syncFilterControlsUI();
    dispatchSearchImmediate(state.query);
  });

  // Boot search worker
  createWorker();
}

init();
