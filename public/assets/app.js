/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Core Application Logic
   Runs on the main UI thread. Never performs heavy computation here.
   All search indexing is delegated to search.worker.js.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const CTX_KEY       = 'focit_ctx';      // localStorage key for user context
const STAGGER_DELAY = 40;              // ms between card entrance animations

// ── Application State ────────────────────────────────────────────────────────

const state = {
  /** Parsed manifest — populated by the Worker when ready */
  allResources: [],

  /** Current Fuse search results (array of {item, score}) — or null (show all) */
  searchResults: null,

  /** Active filter values */
  filters: { type: '', semester: '', year: '' },

  /** User context (level + department) persisted in localStorage */
  context: { level: null, dept: null },

  /** Whether the search index is fully loaded */
  indexReady: false,
};

// ── DOM References ───────────────────────────────────────────────────────────

const dom = {
  // Screens
  onboarding: document.getElementById('onboarding-screen'),
  app:        document.getElementById('app-screen'),

  // Onboarding
  levelGrid:   document.getElementById('level-grid'),
  deptGrid:    document.getElementById('dept-grid'),
  btnStart:    document.getElementById('btn-start'),

  // Header
  contextLevelLabel: document.getElementById('context-level-label'),
  contextDeptLabel:  document.getElementById('context-dept-label'),
  btnChangeContext:  document.getElementById('btn-change-context'),

  // Search
  searchInput: document.getElementById('search-input'),
  searchClear: document.getElementById('search-clear'),

  // Filters
  filterPills:   document.querySelectorAll('.filter-pill'),
  yearFilterRow: document.getElementById('year-filter-row'),

  // Status
  statusDot:   document.getElementById('status-dot'),
  statusText:  document.getElementById('status-text'),
  resultCount: document.getElementById('result-count'),

  // Results
  resultsGrid: document.getElementById('results-grid'),

  // Modal
  modal:           document.getElementById('preview-modal'),
  modalClose:      document.getElementById('modal-close'),
  modalTitle:      document.getElementById('modal-title'),
  modalMeta:       document.getElementById('modal-meta'),
  modalIframe:     document.getElementById('preview-iframe'),
  modalBtnDrive:   document.getElementById('modal-btn-drive'),
  modalBtnDownload:document.getElementById('modal-btn-download'),
};

// ── Web Worker ───────────────────────────────────────────────────────────────

const worker = new Worker('assets/search.worker.js');

worker.onmessage = (e) => {
  const { type } = e.data;

  if (type === 'READY') {
    state.allResources = e.data.resources;
    state.indexReady   = true;

    onIndexReady();
    buildYearFilters();
    renderResults();
  }

  if (type === 'RESULTS') {
    state.searchResults = e.data.results;
    renderResults();
  }

  if (type === 'ERROR') {
    console.error('[App] Worker error:', e.data.message);
    updateStatus('error', 'Search index failed to load. Please refresh.');
  }
};

worker.onerror = (err) => {
  console.error('[App] Worker uncaught error:', err);
};

// ── Debounce Utility ─────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ── Drive URL Helpers ─────────────────────────────────────────────────────────

const drivePreviewUrl  = (fileId) => `https://drive.google.com/file/d/${fileId}/preview`;
const driveDownloadUrl = (fileId) => `https://drive.google.com/uc?export=download&id=${fileId}`;
const driveOpenUrl     = (fileId) => `https://drive.google.com/file/d/${fileId}/view`;

// ── Type → CSS class mapping ──────────────────────────────────────────────────

const TYPE_CLASS = {
  'Past Question': 'past-question',
  'Lecture Notes': 'lecture-notes',
  'Tutorial':      'tutorial',
  'Syllabus':      'syllabus',
  'Textbook':      'textbook',
  'Resource':      'resource',
};

// ── Status Bar ───────────────────────────────────────────────────────────────

function updateStatus(state, text) {
  dom.statusText.textContent = text;
  dom.statusDot.className    = `status-dot ${state}`; // 'loading' | 'ready' | 'error'
}

// ── Index Ready ───────────────────────────────────────────────────────────────

function onIndexReady() {
  dom.searchInput.disabled     = false;
  dom.searchInput.placeholder  = `Search ${state.allResources.length} resources — course code, topic, year…`;

  updateStatus('ready', `${state.allResources.length} resources loaded`);

  // Boot the Worker with the user's context to pre-filter results
  if (state.context.level || state.context.dept) {
    dispatchSearch(dom.searchInput.value);
  }
}

// ── Build Year Filter Pills ───────────────────────────────────────────────────

function buildYearFilters() {
  const years = [...new Set(
    state.allResources
      .map(r => r.year)
      .filter(Boolean)
  )].sort((a, b) => b - a); // descending (newest first)

  years.forEach((year) => {
    const btn = document.createElement('button');
    btn.className         = 'filter-pill';
    btn.dataset.filter    = 'year';
    btn.dataset.value     = String(year);
    btn.id                = `pill-year-${year}`;
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent       = String(year);
    btn.addEventListener('click', onFilterPillClick);
    dom.yearFilterRow.appendChild(btn);
  });
}

// ── Filtering Logic ───────────────────────────────────────────────────────────

function applyFilters(resources) {
  return resources.filter((r) => {
    if (state.filters.type     && r.type     !== state.filters.type)             return false;
    if (state.filters.semester && r.semester !== parseInt(state.filters.semester)) return false;
    if (state.filters.year     && r.year     !== parseInt(state.filters.year))    return false;

    // Context filter (level + department)
    if (state.context.level && r.level !== state.context.level)                  return false;
    if (state.context.dept  && state.context.dept !== 'All Departments'
        && r.department     !== state.context.dept)                              return false;

    return true;
  });
}

// ── Dispatch Search to Worker ─────────────────────────────────────────────────

const dispatchSearch = debounce((query) => {
  if (!state.indexReady) return;

  if (!query.trim()) {
    state.searchResults = null;
    renderResults();
    return;
  }

  worker.postMessage({ type: 'SEARCH', query });
}, 250);

// ── Render Resource Cards ─────────────────────────────────────────────────────

function renderResults() {
  // Source: search results array or full manifest
  const source = state.searchResults !== null
    ? state.searchResults.map(r => r.item)
    : state.allResources;

  const filtered = applyFilters(source);

  dom.resultCount.textContent = filtered.length > 0
    ? `${filtered.length} result${filtered.length !== 1 ? 's' : ''}`
    : '';

  if (filtered.length === 0) {
    dom.resultsGrid.innerHTML = buildEmptyState();
    return;
  }

  // Build fragment to minimise reflows
  const fragment = document.createDocumentFragment();

  filtered.forEach((resource, index) => {
    const card = buildResourceCard(resource, index);
    fragment.appendChild(card);
  });

  dom.resultsGrid.innerHTML = '';
  dom.resultsGrid.appendChild(fragment);
}

// ── Build Resource Card DOM Element ──────────────────────────────────────────

function buildResourceCard(r, index) {
  const typeClass  = TYPE_CLASS[r.type] ?? 'resource';
  const semLabel   = r.semester === 1 ? 'Semester 1' : r.semester === 2 ? 'Semester 2' : '—';
  const levelLabel = r.level ? `${r.level} Level` : '—';

  const card = document.createElement('article');
  card.className = 'resource-card';
  card.style.animationDelay = `${index * STAGGER_DELAY}ms`;
  card.setAttribute('aria-label', `${r.courseCode} — ${r.type}, ${r.year}`);

  card.innerHTML = `
    <div class="card-header">
      <span class="course-code" title="${r.courseTitle}">${r.courseCode}</span>
      <span class="type-badge ${typeClass}">${r.type}</span>
    </div>

    <h3 class="course-title">${escHtml(r.courseTitle)}</h3>

    <div class="card-meta">
      <span class="meta-chip">${escHtml(levelLabel)}</span>
      <span class="meta-chip">${escHtml(semLabel)}</span>
      ${r.year ? `<span class="meta-chip year">${r.year}</span>` : ''}
      ${r.verified === false ? '<span class="meta-chip" title="This entry could not be fully verified by the crawler">⚠ Unverified</span>' : ''}
    </div>

    <div class="card-actions">
      <button
        class="btn-preview"
        data-file-id="${escHtml(r.fileId)}"
        data-title="${escHtml(r.courseCode + ' — ' + r.type)}"
        data-meta="${escHtml(r.courseTitle + ' · ' + levelLabel + ' · ' + (r.year ?? ''))}"
        aria-label="Preview ${r.courseCode} ${r.type}"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Preview
      </button>
      <a
        class="btn-download"
        href="${driveDownloadUrl(r.fileId)}"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Download ${r.courseCode} ${r.type}"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download
      </a>
    </div>
  `;

  // Attach preview button handler
  card.querySelector('.btn-preview').addEventListener('click', onPreviewClick);

  return card;
}

// ── Empty State ───────────────────────────────────────────────────────────────

function buildEmptyState() {
  const hasQuery   = dom.searchInput.value.trim().length > 0;
  const hasFilters = Object.values(state.filters).some(Boolean);

  return `
    <div class="empty-state">
      <div class="empty-icon">${hasQuery ? '🔍' : '📂'}</div>
      <p class="empty-title">
        ${hasQuery ? `No results for "${escHtml(dom.searchInput.value.trim())}"` : 'No resources yet'}
      </p>
      <p class="empty-sub">
        ${hasQuery || hasFilters
          ? 'Try a different search term or clear your filters. You can search by course code, topic name, or year.'
          : 'Resources for your level will appear here once the Academics Committee uploads them.'}
      </p>
      ${hasFilters || hasQuery
        ? `<button id="btn-clear-filters" aria-label="Clear all filters">Clear filters</button>`
        : ''}
    </div>
  `;
}

// ── HTML Escape ───────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#039;');
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function openModal(fileId, title, meta) {
  dom.modalTitle.textContent      = title;
  dom.modalMeta.textContent       = meta;
  dom.modalIframe.src             = drivePreviewUrl(fileId);
  dom.modalBtnDownload.href       = driveDownloadUrl(fileId);
  dom.modalBtnDrive.href          = driveOpenUrl(fileId);

  dom.modal.classList.remove('hidden');
  dom.modal.removeAttribute('aria-hidden');
  document.body.style.overflow    = 'hidden';
  dom.modalClose.focus();
}

function closeModal() {
  dom.modal.classList.add('hidden');
  dom.modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';

  // Clear iframe src to stop any ongoing network request
  setTimeout(() => { dom.modalIframe.src = ''; }, 300);
}

// ── Context (localStorage) ────────────────────────────────────────────────────

function saveContext(level, dept) {
  state.context = { level, dept };
  try {
    localStorage.setItem(CTX_KEY, JSON.stringify({ level, dept }));
  } catch (_) { /* storage unavailable — fail silently */ }
}

function loadContext() {
  try {
    const raw = localStorage.getItem(CTX_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.level || parsed.dept) {
        state.context = parsed;
        return true;
      }
    }
  } catch (_) { /* corrupt storage — ignore */ }
  return false;
}

function updateContextDisplay() {
  dom.contextLevelLabel.textContent = state.context.level
    ? `${state.context.level} Level`
    : 'All Levels';

  dom.contextDeptLabel.textContent = state.context.dept
    ? state.context.dept
    : 'All Departments';
}

// ── Screen Transitions ────────────────────────────────────────────────────────

function showApp() {
  dom.onboarding.classList.add('hidden');
  dom.app.classList.remove('hidden');
  updateContextDisplay();

  // Boot the worker after the screen transition
  worker.postMessage({ type: 'INIT' });
}

function showOnboarding() {
  dom.app.classList.add('hidden');
  dom.onboarding.classList.remove('hidden');

  // Reset onboarding chip selections
  document.querySelectorAll('.select-chip').forEach(c => {
    c.classList.remove('active');
    c.setAttribute('aria-pressed', 'false');
  });
  dom.btnStart.disabled = true;

  // Clear persisted context
  state.context = { level: null, dept: null };
  try { localStorage.removeItem(CTX_KEY); } catch (_) {}
}

// ── Onboarding Chip Selection ─────────────────────────────────────────────────

let selectedLevel = null;
let selectedDept  = null;

function onLevelChipClick(e) {
  const chip = e.currentTarget;
  selectedLevel = parseInt(chip.dataset.level, 10);

  dom.levelGrid.querySelectorAll('.select-chip').forEach(c => {
    c.classList.remove('active');
    c.setAttribute('aria-pressed', 'false');
  });
  chip.classList.add('active');
  chip.setAttribute('aria-pressed', 'true');

  validateStartButton();
}

function onDeptChipClick(e) {
  const chip = e.currentTarget;
  selectedDept = chip.dataset.dept;

  dom.deptGrid.querySelectorAll('.select-chip').forEach(c => {
    c.classList.remove('active');
    c.setAttribute('aria-pressed', 'false');
  });
  chip.classList.add('active');
  chip.setAttribute('aria-pressed', 'true');

  validateStartButton();
}

function validateStartButton() {
  dom.btnStart.disabled = !(selectedLevel && selectedDept);
}

// ── Event Handlers ────────────────────────────────────────────────────────────

function onPreviewClick(e) {
  const btn    = e.currentTarget;
  const fileId = btn.dataset.fileId;
  const title  = btn.dataset.title;
  const meta   = btn.dataset.meta;
  openModal(fileId, title, meta);
}

function onFilterPillClick(e) {
  const pill        = e.currentTarget;
  const filterKey   = pill.dataset.filter;   // 'type' | 'semester' | 'year'
  const filterValue = pill.dataset.value;    // '' = all

  // Update active pill in this filter group
  const groupPills = document.querySelectorAll(`.filter-pill[data-filter="${filterKey}"]`);
  groupPills.forEach(p => {
    p.classList.remove('active');
    p.setAttribute('aria-pressed', 'false');
  });
  pill.classList.add('active');
  pill.setAttribute('aria-pressed', 'true');

  // Update state and re-render
  state.filters[filterKey] = filterValue;
  renderResults();
}

// Results grid — delegated events (preview button + clear filters)
dom.resultsGrid.addEventListener('click', (e) => {
  if (e.target.closest('#btn-clear-filters')) {
    clearAllFilters();
  }
});

function clearAllFilters() {
  state.filters = { type: '', semester: '', year: '' };
  dom.searchInput.value = '';
  dom.searchClear.classList.add('hidden');
  state.searchResults = null;

  // Reset all filter pills to "All"
  dom.filterPills.forEach(p => {
    const isAll = p.dataset.value === '';
    p.classList.toggle('active', isAll);
    p.setAttribute('aria-pressed', isAll ? 'true' : 'false');
  });
  // Reset dynamically generated year pills too
  dom.yearFilterRow.querySelectorAll('.filter-pill:not(#pill-year-all)').forEach(p => {
    p.classList.remove('active');
    p.setAttribute('aria-pressed', 'false');
  });

  renderResults();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function init() {
  // ── Onboarding chip listeners
  dom.levelGrid.querySelectorAll('.select-chip').forEach(c =>
    c.addEventListener('click', onLevelChipClick)
  );
  dom.deptGrid.querySelectorAll('.select-chip').forEach(c =>
    c.addEventListener('click', onDeptChipClick)
  );

  // ── "Access Repository" button
  dom.btnStart.addEventListener('click', () => {
    if (!selectedLevel || !selectedDept) return;
    saveContext(selectedLevel, selectedDept);
    showApp();
  });

  // ── "Change" button in header
  dom.btnChangeContext.addEventListener('click', showOnboarding);

  // ── Search input
  dom.searchInput.addEventListener('input', (e) => {
    const q = e.target.value;
    dom.searchClear.classList.toggle('hidden', q.length === 0);
    dispatchSearch(q);
  });

  // ── Clear search button
  dom.searchClear.addEventListener('click', () => {
    dom.searchInput.value = '';
    dom.searchClear.classList.add('hidden');
    state.searchResults   = null;
    dom.searchInput.focus();
    renderResults();
  });

  // ── Filter pills
  dom.filterPills.forEach(p => p.addEventListener('click', onFilterPillClick));

  // ── Modal close
  dom.modalClose.addEventListener('click', closeModal);
  dom.modal.addEventListener('click', (e) => {
    if (e.target === dom.modal) closeModal(); // click outside modal container
  });

  // ── Keyboard: Escape closes modal, Slash focuses search
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dom.modal.classList.contains('hidden')) {
      closeModal();
      return;
    }
    if (e.key === '/' && document.activeElement !== dom.searchInput) {
      e.preventDefault();
      dom.searchInput.focus();
    }
  });

  // ── Route based on cached context
  if (loadContext()) {
    showApp(); // returning user — skip onboarding
  }
  // else: onboarding screen is already visible by default
}

// Run
init();
