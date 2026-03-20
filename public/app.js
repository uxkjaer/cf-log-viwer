'use strict';

/* ===========================================================================
 *  CF Log Viewer - Frontend Application
 * =========================================================================== */

// --- State ---
const state = {
  entries: [],        // All log entries loaded so far
  filtered: [],       // Current filtered view
  renderedCount: 0,   // How many rows from state.filtered are rendered in the DOM
  selectedId: null,   // Currently selected entry ID
  totalOnServer: 0,
  autoScroll: true,
  wsConnected: false,
  livePaused: false,  // Whether live streaming is paused
  pausedBuffer: [],   // Entries received while paused
  ws: null,           // WebSocket reference
  filters: {
    level: 'all',
    logger: '',
    correlationId: '',
    search: ''
  }
};

// --- DOM refs ---
const dom = {
  appName: document.getElementById('app-name'),
  logCount: document.getElementById('log-count'),
  liveIndicator: document.getElementById('live-indicator'),
  filterLevel: document.getElementById('filter-level'),
  filterLogger: document.getElementById('filter-logger'),
  filterCorrelation: document.getElementById('filter-correlation'),
  filterSearch: document.getElementById('filter-search'),
  btnClearFilters: document.getElementById('btn-clear-filters'),
  btnDownload: document.getElementById('btn-download'),
  autoScroll: document.getElementById('auto-scroll'),
  tablePanel: document.getElementById('table-panel'),
  tbody: document.getElementById('log-tbody'),
  showingCount: document.getElementById('showing-count'),
  btnLoadMore: document.getElementById('btn-load-more'),
  detailPanel: document.getElementById('detail-panel'),
  detailId: document.getElementById('detail-id'),
  detailContent: document.getElementById('detail-content'),
  btnCloseDetail: document.getElementById('btn-close-detail')
};

// --- Constants ---
const RENDER_BATCH_SIZE = 200;  // How many rows to render at once
const DEBOUNCE_MS = 250;

// --- Category display config ---
const CATEGORY_CONFIG = {
  core: { label: 'Core Info', open: true },
  http: { label: 'HTTP Context', open: false },
  tracing: { label: 'Tracing & Correlation', open: true },
  infrastructure: { label: 'Infrastructure', open: false },
  sap: { label: 'SAP-specific', open: false },
  other: { label: 'Other Fields', open: false }
};

/* ===========================================================================
 *  Initialization
 * =========================================================================== */

async function init() {
  // Load initial data
  await loadLogs();

  // Check if live mode is enabled on the server
  try {
    const metaRes = await fetch('/api/meta');
    const meta = await metaRes.json();
    state.liveEnabled = !!meta.live;
  } catch {
    state.liveEnabled = false;
  }

  if (state.liveEnabled) {
    // Setup WebSocket only in live mode
    connectWebSocket();
  } else {
    // Hide live button when not in live mode
    dom.liveIndicator.style.display = 'none';
  }

  // Setup event listeners
  setupEventListeners();
}

async function loadLogs() {
  try {
    const params = buildFilterParams();
    const res = await fetch(`/api/logs?limit=5000&${params}`);
    const data = await res.json();

    dom.appName.textContent = data.appName;
    document.title = `CF Logs - ${data.appName}`;

    state.entries = data.entries;
    state.totalOnServer = data.total;

    applyFilters();
    renderTable();
    updateCounts();
  } catch (err) {
    console.error('Failed to load logs:', err);
    dom.tbody.innerHTML = `<tr><td colspan="7" class="empty-state"><h3>Failed to load logs</h3><p>${err.message}</p></td></tr>`;
  }
}

/* ===========================================================================
 *  WebSocket
 * =========================================================================== */

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsConnected = true;
    dom.liveIndicator.classList.remove('disconnected');
    updateLiveButton();
  };

  ws.onclose = () => {
    state.wsConnected = false;
    state.ws = null;
    dom.liveIndicator.classList.add('disconnected');
    dom.liveIndicator.textContent = 'DISCONNECTED';
    dom.liveIndicator.title = 'Disconnected - will retry...';
    // Reconnect after 3s
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => {
    state.wsConnected = false;
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      if (msg.type === 'newLog') {
        // Always track on server count
        state.totalOnServer++;

        if (state.livePaused) {
          // Buffer entries while paused
          state.pausedBuffer.push(msg.entry);
          updateLiveButton();
          return;
        }

        state.entries.push(msg.entry);

        // Check if it passes current filters
        if (matchesFilters(msg.entry)) {
          state.filtered.push(msg.entry);
          appendRow(msg.entry, true);
        }

        updateCounts();

        if (state.autoScroll) {
          scrollToBottom();
        }
      } else if (msg.type === 'init') {
        state.totalOnServer = msg.totalEntries;
        updateCounts();
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  };
}

function toggleLivePause() {
  if (!state.wsConnected) return;

  state.livePaused = !state.livePaused;

  if (!state.livePaused && state.pausedBuffer.length > 0) {
    // Flush buffered entries
    const buffered = state.pausedBuffer;
    state.pausedBuffer = [];

    for (const entry of buffered) {
      state.entries.push(entry);
      if (matchesFilters(entry)) {
        state.filtered.push(entry);
        appendRow(entry, true);
      }
    }

    updateCounts();

    if (state.autoScroll) {
      scrollToBottom();
    }
  }

  updateLiveButton();
}

function updateLiveButton() {
  if (!state.wsConnected) {
    dom.liveIndicator.classList.add('disconnected');
    dom.liveIndicator.classList.remove('paused');
    dom.liveIndicator.textContent = 'DISCONNECTED';
    dom.liveIndicator.title = 'Disconnected - will retry...';
  } else if (state.livePaused) {
    dom.liveIndicator.classList.remove('disconnected');
    dom.liveIndicator.classList.add('paused');
    const count = state.pausedBuffer.length;
    dom.liveIndicator.textContent = count > 0 ? `PAUSED (${count})` : 'PAUSED';
    dom.liveIndicator.title = 'Click to resume live streaming' + (count > 0 ? ` - ${count} buffered` : '');
  } else {
    dom.liveIndicator.classList.remove('disconnected', 'paused');
    dom.liveIndicator.textContent = 'LIVE';
    dom.liveIndicator.title = 'Click to pause live streaming';
  }
}

/* ===========================================================================
 *  Filtering
 * =========================================================================== */

function buildFilterParams() {
  const params = new URLSearchParams();
  if (state.filters.level !== 'all') params.set('level', state.filters.level);
  if (state.filters.logger) params.set('logger', state.filters.logger);
  if (state.filters.correlationId) params.set('correlation_id', state.filters.correlationId);
  if (state.filters.search) params.set('search', state.filters.search);
  return params.toString();
}

function matchesFilters(entry) {
  const f = state.filters;

  if (f.level !== 'all' && entry.level !== f.level) return false;

  if (f.logger && !(entry.logger && entry.logger.toLowerCase().includes(f.logger.toLowerCase()))) return false;

  if (f.correlationId && entry.correlationId !== f.correlationId) return false;

  if (f.search) {
    const s = f.search.toLowerCase();
    const inMsg = entry.msg && entry.msg.toLowerCase().includes(s);
    const inLogger = entry.logger && entry.logger.toLowerCase().includes(s);
    const inRaw = entry.raw && entry.raw.toLowerCase().includes(s);
    if (!inMsg && !inLogger && !inRaw) return false;
  }

  return true;
}

function applyFilters() {
  state.filtered = state.entries.filter(matchesFilters);
}

function onFilterChange() {
  state.filters.level = dom.filterLevel.value;
  state.filters.logger = dom.filterLogger.value.trim();
  state.filters.correlationId = dom.filterCorrelation.value.trim();
  state.filters.search = dom.filterSearch.value.trim();

  applyFilters();
  renderTable();
  updateCounts();
}

function clearFilters() {
  dom.filterLevel.value = 'all';
  dom.filterLogger.value = '';
  dom.filterCorrelation.value = '';
  dom.filterSearch.value = '';
  onFilterChange();
}

/* ===========================================================================
 *  Table Rendering
 * =========================================================================== */

function renderTable() {
  dom.tbody.innerHTML = '';
  state.renderedCount = 0;

  if (state.filtered.length === 0) {
    dom.tbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="empty-state">
            <h3>No log entries</h3>
            <p>No entries match the current filters.</p>
          </div>
        </td>
      </tr>`;
    updateLoadMoreButton();
    return;
  }

  // Render in batches for performance
  const fragment = document.createDocumentFragment();
  const end = Math.min(state.filtered.length, RENDER_BATCH_SIZE);

  for (let i = 0; i < end; i++) {
    fragment.appendChild(createRow(state.filtered[i]));
  }

  dom.tbody.appendChild(fragment);
  state.renderedCount = end;
  updateLoadMoreButton();
}

function loadMoreRows() {
  const start = state.renderedCount;
  const end = Math.min(state.filtered.length, start + RENDER_BATCH_SIZE);

  if (start >= end) return;

  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    fragment.appendChild(createRow(state.filtered[i]));
  }
  dom.tbody.appendChild(fragment);
  state.renderedCount = end;
  updateLoadMoreButton();
  updateCounts();
}

function updateLoadMoreButton() {
  const remaining = state.filtered.length - state.renderedCount;
  if (remaining > 0) {
    dom.btnLoadMore.style.display = 'inline-block';
    dom.btnLoadMore.textContent = `Load more (${remaining} remaining)`;
  } else {
    dom.btnLoadMore.style.display = 'none';
  }
}

function createRow(entry) {
  const tr = document.createElement('tr');
  tr.dataset.id = entry.id;
  tr.className = `level-${entry.level}`;

  if (state.selectedId === entry.id) {
    tr.classList.add('selected');
  }

  const ts = formatTimestamp(entry.timestamp);
  const msg = escapeHtml(truncate(entry.msg, 200));
  const corrShort = entry.correlationId ? entry.correlationId.substring(0, 8) + '...' : '';

  tr.innerHTML = `
    <td class="mono col-id">${entry.id}</td>
    <td class="mono col-timestamp">${ts}</td>
    <td class="col-level"><span class="level-badge ${entry.level}">${entry.level}</span></td>
    <td class="col-source"><span class="source-badge">${escapeHtml(entry.source)}</span></td>
    <td class="mono col-logger">${escapeHtml(entry.logger)}</td>
    <td class="msg-cell col-message" title="${escapeHtml(entry.msg)}">${msg}</td>
    <td class="col-correlation">${entry.correlationId ? `<span class="correlation-link" data-corr="${escapeHtml(entry.correlationId)}" title="${escapeHtml(entry.correlationId)}">${corrShort}</span>` : ''}</td>
  `;

  tr.addEventListener('click', (e) => {
    // If clicking correlation link, filter by it instead
    if (e.target.classList.contains('correlation-link')) {
      e.stopPropagation();
      filterByCorrelation(e.target.dataset.corr);
      return;
    }
    selectEntry(entry.id);
  });

  return tr;
}

function appendRow(entry, isNew = false) {
  const tr = createRow(entry);
  if (isNew) {
    tr.classList.add('new-entry');
  }
  dom.tbody.appendChild(tr);
  state.renderedCount++;
  updateLoadMoreButton();
}

function scrollToBottom() {
  dom.tablePanel.scrollTop = dom.tablePanel.scrollHeight;
}

/* ===========================================================================
 *  Detail Panel
 * =========================================================================== */

async function selectEntry(id) {
  // Deselect previous
  const prev = dom.tbody.querySelector('.selected');
  if (prev) prev.classList.remove('selected');

  state.selectedId = id;

  // Highlight selected row
  const row = dom.tbody.querySelector(`tr[data-id="${id}"]`);
  if (row) row.classList.add('selected');

  // Fetch full detail
  try {
    const res = await fetch(`/api/logs/${id}`);
    const entry = await res.json();
    renderDetail(entry);
    dom.detailPanel.classList.remove('hidden');
  } catch (err) {
    console.error('Failed to load entry detail:', err);
  }
}

function closeDetail() {
  dom.detailPanel.classList.add('hidden');
  state.selectedId = null;
  const prev = dom.tbody.querySelector('.selected');
  if (prev) prev.classList.remove('selected');
}

function renderDetail(entry) {
  dom.detailId.textContent = `#${entry.id}`;

  let html = '';

  // --- Message section (always open) ---
  html += `
    <div class="detail-section">
      <div class="detail-section-header" data-section="message">
        <span class="detail-section-title">Message</span>
        <span class="detail-section-toggle">&#9660;</span>
      </div>
      <div class="detail-section-body">
        <div class="kv-table">
          <table class="kv-table">
            <tr><td class="kv-key">level</td><td class="kv-value"><span class="level-badge ${entry.level}">${entry.level}</span></td></tr>
            <tr><td class="kv-key">timestamp</td><td class="kv-value">${escapeHtml(entry.timestamp || '')}</td></tr>
            <tr><td class="kv-key">logger</td><td class="kv-value">${escapeHtml(entry.logger || '')}</td></tr>
            <tr><td class="kv-key">source</td><td class="kv-value">${escapeHtml(entry.source || '')}</td></tr>
            <tr><td class="kv-key">cf_timestamp</td><td class="kv-value">${escapeHtml(entry.cfTimestamp || '')}</td></tr>
            <tr><td class="kv-key">msg</td><td class="kv-value msg-value">${escapeHtml(entry.msg || '')}</td></tr>
          </table>
        </div>
      </div>
    </div>`;

  // --- Categorized sections ---
  if (entry.categories) {
    for (const [catKey, catConfig] of Object.entries(CATEGORY_CONFIG)) {
      if (catKey === 'core') continue; // Already shown in message section
      const fields = entry.categories[catKey];
      if (!fields || Object.keys(fields).length === 0) continue;

      const collapsed = !catConfig.open;
      html += `
        <div class="detail-section">
          <div class="detail-section-header" data-section="${catKey}">
            <span class="detail-section-title">${catConfig.label} (${Object.keys(fields).length})</span>
            <span class="detail-section-toggle ${collapsed ? 'collapsed' : ''}">&#9660;</span>
          </div>
          <div class="detail-section-body ${collapsed ? 'collapsed' : ''}">
            <table class="kv-table">
              ${Object.entries(fields).map(([k, v]) => `
                <tr>
                  <td class="kv-key">${escapeHtml(k)}</td>
                  <td class="kv-value">${formatValue(k, v)}</td>
                </tr>
              `).join('')}
            </table>
          </div>
        </div>`;
    }
  }

  // --- Raw JSON section ---
  if (entry.json) {
    html += `
      <div class="detail-section">
        <div class="detail-section-header" data-section="raw">
          <span class="detail-section-title">Raw JSON</span>
          <span class="detail-section-toggle collapsed">&#9660;</span>
        </div>
        <div class="detail-section-body collapsed">
          <div class="raw-json">${syntaxHighlight(JSON.stringify(entry.json, null, 2))}</div>
        </div>
      </div>`;
  } else if (entry.raw) {
    html += `
      <div class="detail-section">
        <div class="detail-section-header" data-section="raw">
          <span class="detail-section-title">Raw Output</span>
          <span class="detail-section-toggle collapsed">&#9660;</span>
        </div>
        <div class="detail-section-body collapsed">
          <div class="raw-json">${escapeHtml(entry.raw)}</div>
        </div>
      </div>`;
  }

  dom.detailContent.innerHTML = html;

  // Attach section toggle handlers
  dom.detailContent.querySelectorAll('.detail-section-header').forEach(header => {
    header.addEventListener('click', () => {
      const body = header.nextElementSibling;
      const toggle = header.querySelector('.detail-section-toggle');
      body.classList.toggle('collapsed');
      toggle.classList.toggle('collapsed');
    });
  });
}

/* ===========================================================================
 *  Helpers
 * =========================================================================== */

function filterByCorrelation(corrId) {
  dom.filterCorrelation.value = corrId;
  onFilterChange();
}

function downloadFilteredLogs() {
  // Export the full JSON payload for filtered entries (use .json if available, else raw)
  const exportData = state.filtered.map(entry => entry.json || {
    timestamp: entry.timestamp,
    level: entry.level,
    source: entry.source,
    logger: entry.logger,
    msg: entry.msg,
    raw: entry.raw
  });

  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  a.download = `cf-logs-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function updateCounts() {
  dom.logCount.textContent = `${state.entries.length} entries`;
  const rendered = state.renderedCount;
  const filtered = state.filtered.length;
  const total = state.entries.length;
  if (rendered < filtered) {
    dom.showingCount.textContent = `Showing ${rendered} of ${filtered} matching (${total} total)`;
  } else {
    dom.showingCount.textContent = `Showing ${filtered} of ${total} entries`;
  }
}

function formatTimestamp(ts) {
  if (!ts) return '-';
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return escapeHtml(ts);
    return d.toISOString().replace('T', ' ').replace('Z', '');
  } catch {
    return escapeHtml(ts);
  }
}

function formatValue(key, value) {
  if (value === null || value === undefined) {
    return '<span class="json-null">null</span>';
  }

  if (typeof value === 'object') {
    return `<div class="raw-json" style="max-height:200px">${syntaxHighlight(JSON.stringify(value, null, 2))}</div>`;
  }

  const str = String(value);

  // Make correlation IDs clickable
  if (key.includes('correlation') || key.includes('request_id') || key.includes('trace')) {
    return `<span class="correlation-link" data-corr="${escapeHtml(str)}" title="Click to filter">${escapeHtml(str)}</span>`;
  }

  // Truncate very long values (like tenant_host_pattern)
  if (str.length > 300) {
    return `<span title="${escapeHtml(str)}">${escapeHtml(str.substring(0, 300))}...</span>`;
  }

  return escapeHtml(str);
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function syntaxHighlight(json) {
  return escapeHtml(json).replace(
    /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'json-number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'json-key';
        } else {
          cls = 'json-string';
        }
      } else if (/true|false/.test(match)) {
        cls = 'json-boolean';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ===========================================================================
 *  Event Listeners
 * =========================================================================== */

function setupEventListeners() {
  // Filter controls
  dom.filterLevel.addEventListener('change', onFilterChange);

  const debouncedFilter = debounce(onFilterChange, DEBOUNCE_MS);
  dom.filterLogger.addEventListener('input', debouncedFilter);
  dom.filterCorrelation.addEventListener('input', debouncedFilter);
  dom.filterSearch.addEventListener('input', debouncedFilter);

  dom.btnClearFilters.addEventListener('click', clearFilters);
  dom.btnDownload.addEventListener('click', downloadFilteredLogs);

  // Live toggle button
  dom.liveIndicator.addEventListener('click', toggleLivePause);

  // Auto-scroll toggle
  dom.autoScroll.addEventListener('change', () => {
    state.autoScroll = dom.autoScroll.checked;
  });

  // Load more
  dom.btnLoadMore.addEventListener('click', loadMoreRows);

  // Close detail
  dom.btnCloseDetail.addEventListener('click', closeDetail);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDetail();
    }
  });

  // Correlation link clicks within detail panel
  dom.detailContent.addEventListener('click', (e) => {
    if (e.target.classList.contains('correlation-link')) {
      filterByCorrelation(e.target.dataset.corr);
    }
  });
}

/* ===========================================================================
 *  Boot
 * =========================================================================== */

init();
