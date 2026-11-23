/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Client Application Logic
   Zero-trust client: strict escaping, URL state sync, monotonic search IDs,
   resilient error recovery, and paginated dense row rendering.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const PREF_KEY = 'focit_prefs_v2';
const PAGE_SIZE = 50;
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

  filterPanel:      document.querySelector('.filter-panel'),
  yearFilterRow:    document.getElementById('year-filter-row'),

  statusDot:        document.getElementById('status-dot'),
  statusText:       document.getElementById('status-text'),
  resultCount:      document.getElementById('result-count'),
  btnResetFilters:  document.getElementById('btn-reset-filters'),

  resultsGrid:      document.getElementById('results-grid'),
  paginationBar:    document.getElementById('pagination-bar'),
  btnLoadMore:      document.getElementById('btn-load-more'),

  modal:            document.getElementById('preview-modal'),
  modalClose:       document.getElementById('modal-close'),
  modalTitle:       document.getElementById('modal-title'),
  modalMeta:        document.getElementById('modal-meta'),
  modalIframe:      document.getElementById('preview-iframe'),
  modalBtnDrive:    document.getElementById('modal-btn-drive'),
  modalBtnDownload: document.getElementById('modal-btn-download'),
};

// ── Security & Validation Helpers ─────────────────────────────────────────────

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

  const previewUrl  = SAFE_DRIVE_URL_RE.test(resource.previewUrl || '') ? resource.previewUrl : fallbackPreview;
  const downloadUrl = SAFE_DRIVE_URL_RE.test(resource.downloadUrl || '') ? resource.downloadUrl : fallbackDownload;
  const driveViewUrl = SAFE_DRIVE_URL_RE.test(resource.driveViewUrl || '') ? resource.driveViewUrl : fallbackView;

  return { valid: true, previewUrl, downloadUrl, driveViewUrl };
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
    worker = new Worker('assets/search.worker.js?v=2026.2');
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
        return; // Drop stale out-of-order response
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

  dom.headerTotalBadge.textContent = `${resources.length} resources`;
  updateStatus('ready', `${resources.length} resources indexed`);

  buildYearFilters();
  syncFilterPillsUI();

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

// ── URL State & Preference Persistence ────────────────────────────────────────

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
  } else {
    try {
      const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
      state.filters.dept  = typeof saved.dept === 'string' ? saved.dept : '';
      state.filters.level = typeof saved.level === 'string' ? saved.level : '';
    } catch (_) { }
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
    localStorage.setItem(PREF_KEY, JSON.stringify({
      dept: state.filters.dept,
      level: state.filters.level,
    }));
  } catch (_) { }
}

// ── Status & UI Sync ──────────────────────────────────────────────────────────

function updateStatus(dotState, text) {
  dom.statusText.textContent = text;
  dom.statusDot.className = `status-dot ${dotState}`;
}

function updateSearchDecorators() {
  const hasText = dom.searchInput.value.length > 0;
  dom.searchClear.classList.toggle('hidden', !hasText);
  dom.searchKbd.classList.toggle('hidden', hasText);
}

function syncFilterPillsUI() {
  document.querySelectorAll('.filter-pill').forEach((pill) => {
    const key = pill.dataset.filter;
    const val = pill.dataset.value ?? '';
    const isActive = (state.filters[key] ?? '') === val;
    pill.classList.toggle('active', isActive);
    pill.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  const anyActive = Boolean(state.query.trim()) || Object.values(state.filters).some(Boolean);
  dom.btnResetFilters.classList.toggle('hidden', !anyActive);
}

function buildYearFilters() {
  // Remove previous dynamic year pills cleanly (prevent duplicate DOM nodes)
  dom.yearFilterRow.querySelectorAll('.filter-pill:not(#pill-year-all)').forEach(el => el.remove());

  const years = [...new Set(
    state.allResources.map(r => r.year).filter(Boolean)
  )].sort((a, b) => b - a);

  if (years.length === 0) {
    dom.yearFilterRow.classList.add('hidden');
    return;
  }

  dom.yearFilterRow.classList.remove('hidden');
  for (const year of years) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-pill';
    btn.dataset.filter = 'year';
    btn.dataset.value = String(year);
    btn.id = `pill-year-${year}`;
    btn.setAttribute('aria-pressed', state.filters.year === String(year) ? 'true' : 'false');
    btn.textContent = String(year);
    dom.yearFilterRow.appendChild(btn);
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
    // Fallback substring match if Worker unavailable
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

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderResults() {
  if (!state.indexReady) return;

  const source = state.searchResults !== null
    ? state.searchResults.map(r => r.item)
    : state.allResources;

  const filtered = applyFilters(source);

  dom.resultCount.textContent = filtered.length === 1
    ? '1 resource'
    : `${filtered.length} resources`;

  if (filtered.length === 0) {
    dom.paginationBar.classList.add('hidden');
    dom.resultsGrid.innerHTML = buildEmptyState();
    return;
  }

  const slice = filtered.slice(0, state.visibleLimit);
  const fragment = document.createDocumentFragment();

  for (const resource of slice) {
    fragment.appendChild(buildResourceRow(resource));
  }

  dom.resultsGrid.innerHTML = '';
  dom.resultsGrid.appendChild(fragment);

  const remaining = filtered.length - slice.length;
  if (remaining > 0) {
    dom.paginationBar.classList.remove('hidden');
    dom.btnLoadMore.textContent = `Show more (${remaining} remaining)`;
  } else {
    dom.paginationBar.classList.add('hidden');
  }
}

function buildResourceRow(r) {
  const typeClass = TYPE_CLASS[r.type] ?? 'resource';
  const urls = getSafeDriveUrls(r);
  const levelLabel = r.level ? `${r.level}L` : null;
  const semLabel = r.semester === 1 ? 'Sem 1' : r.semester === 2 ? 'Sem 2' : null;
  const isShared = Array.isArray(r.departments) && r.departments.includes('ALL');
  const deptLabel = isShared ? 'Shared (All Depts)' : (r.department || 'General');
  const fileExt = String(r.fileExt || 'PDF').toUpperCase();
  const displayTitle = r.courseTitle || r.courseCode || 'Untitled Resource';

  const metaParts = [deptLabel, levelLabel, semLabel, r.year ? String(r.year) : null].filter(Boolean);

  const row = document.createElement('article');
  row.className = 'resource-row';
  row.setAttribute('aria-label', `${r.courseCode || 'Resource'} — ${displayTitle}`);

  row.innerHTML = `
    <div class="row-main">
      <div class="row-top">
        <span class="course-code">${escHtml(r.courseCode || 'GENERAL')}</span>
        <span class="ext-badge">${escHtml(fileExt)}</span>
        <span class="type-badge ${escHtml(typeClass)}">${escHtml(r.type || 'Resource')}</span>
        ${isShared ? '<span class="shared-badge">Faculty-wide</span>' : ''}
      </div>
      <h3 class="row-title">${escHtml(displayTitle)}</h3>
      <div class="row-sub">
        <span>${metaParts.map(escHtml).join(' <span class="meta-sep">·</span> ')}</span>
        ${r.fileName ? `<span class="meta-sep">·</span><span class="row-filename" title="${escHtml(r.fileName)}">${escHtml(r.fileName)}</span>` : ''}
      </div>
    </div>
    <div class="row-actions">
      <button
        type="button"
        class="btn-preview"
        data-preview-url="${escHtml(urls.previewUrl)}"
        data-download-url="${escHtml(urls.downloadUrl)}"
        data-drive-url="${escHtml(urls.driveViewUrl)}"
        data-title="${escHtml((r.courseCode || 'Resource') + ' — ' + displayTitle)}"
        data-meta="${escHtml(metaParts.join(' · ') + ' · ' + fileExt)}"
        ${urls.valid ? '' : 'disabled'}
        aria-label="Preview ${escHtml(r.courseCode || '')} ${escHtml(r.type || 'document')}"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Preview
      </button>
      <a
        class="btn-download${urls.valid ? '' : ' disabled'}"
        href="${escHtml(urls.downloadUrl)}"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Download ${escHtml(r.courseCode || '')} ${escHtml(r.fileName || 'document')}"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download
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
    ? 'Try searching by course code (e.g. CSC 202 or COS 204), topic, or clear active filters.'
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

// ── Native <dialog> Preview Modal ─────────────────────────────────────────────

function openModal(triggerBtn) {
  if (state.modalClearTimer) {
    clearTimeout(state.modalClearTimer);
    state.modalClearTimer = null;
  }

  state.lastModalTrigger = triggerBtn;

  const previewUrl  = triggerBtn.dataset.previewUrl;
  const downloadUrl = triggerBtn.dataset.downloadUrl;
  const driveUrl    = triggerBtn.dataset.driveUrl;
  const title       = triggerBtn.dataset.title || 'Document Preview';
  const meta        = triggerBtn.dataset.meta || '';

  if (!SAFE_DRIVE_URL_RE.test(previewUrl || '')) return;

  dom.modalTitle.textContent = title;
  dom.modalMeta.textContent = meta;
  dom.modalIframe.src = previewUrl;
  dom.modalBtnDownload.href = SAFE_DRIVE_URL_RE.test(downloadUrl || '') ? downloadUrl : '#';
  dom.modalBtnDrive.href = SAFE_DRIVE_URL_RE.test(driveUrl || '') ? driveUrl : '#';

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
  state.searchResults = null;
  state.visibleLimit = PAGE_SIZE;
  state.latestSearchRequestId += 1;

  dom.searchInput.value = '';
  updateSearchDecorators();
  syncFilterPillsUI();
  syncUrlAndPrefs();
  renderResults();
}

// ── Event Wiring ──────────────────────────────────────────────────────────────

function init() {
  readStateFromUrlOrStorage();
  syncFilterPillsUI();

  // Delegated click handler for all filter pills (including dynamically added years)
  dom.filterPanel.addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;

    const filterKey = pill.dataset.filter;
    const filterVal = pill.dataset.value ?? '';
    if (!filterKey) return;

    state.filters[filterKey] = filterVal;
    state.visibleLimit = PAGE_SIZE;

    syncFilterPillsUI();
    syncUrlAndPrefs();
    renderResults();
  });

  // Search input
  dom.searchInput.addEventListener('input', (e) => {
    state.query = e.target.value;
    updateSearchDecorators();
    syncUrlAndPrefs();
    dispatchSearch(state.query);
  });

  // Clear search
  dom.searchClear.addEventListener('click', () => {
    state.query = '';
    dom.searchInput.value = '';
    updateSearchDecorators();
    syncUrlAndPrefs();
    dispatchSearchImmediate('');
    dom.searchInput.focus();
  });

  // Reset filters (status bar button)
  dom.btnResetFilters.addEventListener('click', clearAllFilters);

  // Results list delegated actions (Preview, Clear filters, Retry)
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

  // Load more pagination
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

  // Native <dialog> events
  dom.modalClose.addEventListener('click', closeModal);
  dom.modal.addEventListener('click', (e) => {
    if (e.target === dom.modal) closeModal();
  });
  dom.modal.addEventListener('close', () => {
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
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        dom.searchInput.focus();
      }
    }
  });

  // Sync browser back/forward navigation
  window.addEventListener('popstate', () => {
    readStateFromUrlOrStorage();
    syncFilterPillsUI();
    dispatchSearchImmediate(state.query);
  });

  // Boot search worker
  createWorker();
}

init();
