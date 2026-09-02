// Check authentication
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) {
      window.location.href = '/admin/login.html';
      return null;
    }
    const user = await res.json();

    // Update sidebar user info
    const avatar = document.getElementById('userAvatar');
    const name = document.getElementById('userName');
    const email = document.getElementById('userEmail');

    if (avatar) avatar.textContent = user.name.charAt(0).toUpperCase();
    if (name) name.textContent = user.name;
    if (email) email.textContent = user.email;

    return user;
  } catch (err) {
    window.location.href = '/admin/login.html';
    return null;
  }
}

// Logout
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/admin/login.html';
}

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Ensure a date string from the DB (UTC) is parsed as UTC, not local time
function parseUtcDate(dateStr) {
  if (!dateStr) return new Date(NaN);
  let s = String(dateStr).trim();
  // SQLite format "2026-02-12 11:45:00" → treat as UTC
  if (!s.endsWith('Z') && !s.includes('+') && !s.includes('-', 10)) {
    s = s.replace(' ', 'T') + 'Z';
  }
  return new Date(s);
}

// Format date
function formatDate(dateStr) {
  const d = parseUtcDate(dateStr);
  if (isNaN(d)) return '-';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: getConfiguredTz()
  });
}

// Show modal
function showModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

// Hide modal
function hideModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

// API helper
async function api(endpoint, options = {}) {
  const res = await fetch(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // Server returned HTML (502/504/error page) instead of JSON
    throw new Error('Server error (' + res.status + '). Please try again in a moment.');
  }

  if (!res.ok) {
    throw new Error(data.error || 'API Error (' + res.status + ')');
  }

  return data;
}

// Local date helper (uses configured timezone)
function toLocalDate(d) {
  return d.toLocaleDateString('en-CA', { timeZone: getConfiguredTz() });
}

// Time range helper
function getDateRangeFromPreset(range) {
  const now = new Date();
  const today = toLocalDate(now);
  if (range === 'all') return { from: '', to: '' };
  if (range === 'today') return { from: today, to: today };
  if (range === 'yesterday') {
    const y = toLocalDate(new Date(now.getTime() - 86400000));
    return { from: y, to: y };
  }
  // Use time subtraction to avoid browser-timezone date component issues
  var daysBack;
  if (range === 'last_week') daysBack = 7;
  else if (range === '7d') daysBack = 7;
  else if (range === '30d') daysBack = 30;
  else if (range === 'mtd') {
    // Derive first-of-month from the configured timezone date string
    var parts = today.split('-');
    return { from: parts[0] + '-' + parts[1] + '-01', to: today };
  } else {
    return { from: '', to: '' };
  }
  return { from: toLocalDate(new Date(now.getTime() - daysBack * 86400000)), to: today };
}

function initTimeRangeBtns(containerSelector, onApply) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.querySelectorAll('.time-range-btns button[data-range]').forEach(btn => {
    btn.addEventListener('click', function() {
      container.querySelectorAll('.time-range-btns button').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      const range = this.dataset.range;
      const fromEl = container.querySelector('.tr-from');
      const toEl = container.querySelector('.tr-to');
      if (range === 'custom') {
        if (fromEl) fromEl.style.display = '';
        if (toEl) toEl.style.display = '';
      } else {
        if (fromEl) fromEl.style.display = 'none';
        if (toEl) toEl.style.display = 'none';
        if (onApply) onApply(range);
      }
    });
  });
}

// Column Editor
class ColumnEditor {
  constructor({ pageId, columns, mountTo, onColumnsChange }) {
    this.pageId = pageId;
    this.columns = columns;
    this.storageKey = 'columns_' + pageId;
    this.mountTo = mountTo;
    this.onColumnsChange = onColumnsChange;
    this.open = false;
    this.dragIndex = null;
    this._load();
    this.render();
    this._outsideClickHandler = (e) => {
      if (this.open && this._panel && !this._panel.contains(e.target) && !this._btn.contains(e.target)) {
        this._close();
      }
    };
    document.addEventListener('click', this._outsideClickHandler);
  }

  _load() {
    const saved = localStorage.getItem(this.storageKey);
    if (saved) {
      try {
        const { order, hidden } = JSON.parse(saved);
        this.order = order;
        this.hidden = new Set(hidden);
      } catch (e) {
        this._defaults();
      }
    } else {
      this._defaults();
    }
    this._syncOrder();
  }

  _defaults() {
    this.order = this.columns.map(c => c.key);
    this.hidden = new Set(this.columns.filter(c => c.default === false).map(c => c.key));
  }

  _syncOrder() {
    const allKeys = new Set(this.columns.map(c => c.key));
    this.order = this.order.filter(k => allKeys.has(k));
    for (const c of this.columns) {
      if (!this.order.includes(c.key)) this.order.push(c.key);
    }
    // Locked columns always at end
    const locked = this.columns.filter(c => c.locked).map(c => c.key);
    this.order = this.order.filter(k => !locked.includes(k)).concat(locked);
  }

  _save() {
    localStorage.setItem(this.storageKey, JSON.stringify({
      order: this.order,
      hidden: [...this.hidden]
    }));
  }

  getVisibleColumns() {
    return this.order.filter(k => !this.hidden.has(k));
  }

  renderHeader() {
    const colMap = {};
    this.columns.forEach(c => colMap[c.key] = c);
    const widths = this._loadWidths();
    return this.getVisibleColumns().map(k => {
      var w = widths[k] ? ' style="width:' + widths[k] + 'px"' : '';
      return '<th data-col="' + k + '"' + w + '>' + (colMap[k] ? colMap[k].label : k) + '<div class="col-resize"></div></th>';
    }).join('');
  }

  _loadWidths() {
    try { return JSON.parse(localStorage.getItem('colWidths_' + this.pageId) || '{}'); } catch(e) { return {}; }
  }

  _saveWidths(widths) {
    localStorage.setItem('colWidths_' + this.pageId, JSON.stringify(widths));
  }

  initResize(tableEl) {
    if (!tableEl) return;
    var self = this;
    tableEl.querySelectorAll('th .col-resize').forEach(function(handle) {
      handle.addEventListener('mousedown', function(e) {
        e.preventDefault();
        var th = handle.parentElement;
        var startX = e.clientX;
        var startW = th.offsetWidth;
        handle.classList.add('active');
        function onMove(ev) {
          var newW = Math.max(40, startW + ev.clientX - startX);
          th.style.width = newW + 'px';
        }
        function onUp() {
          handle.classList.remove('active');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          // Save all current widths
          var widths = self._loadWidths();
          tableEl.querySelectorAll('th[data-col]').forEach(function(h) {
            widths[h.dataset.col] = h.offsetWidth;
          });
          self._saveWidths(widths);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  isVisible(key) {
    return !this.hidden.has(key);
  }

  render() {
    const mount = document.querySelector(this.mountTo);
    if (!mount) return;
    mount.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'col-editor-wrap';

    const btn = document.createElement('button');
    btn.className = 'col-editor-btn';
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.6 9a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 3a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg> Columns';
    btn.onclick = () => this.open ? this._close() : this._open();
    this._btn = btn;

    const panel = document.createElement('div');
    panel.className = 'col-editor-panel';
    panel.style.display = 'none';
    this._panel = panel;

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    mount.appendChild(wrap);
  }

  _open() {
    this.open = true;
    this._renderPanel();
    this._panel.style.display = '';
    this._btn.classList.add('active');
  }

  _close() {
    this.open = false;
    this._panel.style.display = 'none';
    this._btn.classList.remove('active');
  }

  _renderPanel() {
    const colMap = {};
    this.columns.forEach(c => colMap[c.key] = c);

    let html = '<div class="col-editor-list">';
    for (let i = 0; i < this.order.length; i++) {
      const key = this.order[i];
      const col = colMap[key];
      if (!col) continue;
      const locked = col.locked;
      const checked = !this.hidden.has(key);
      html += '<div class="col-editor-item" draggable="' + (!locked) + '" data-index="' + i + '">' +
        (!locked ? '<span class="col-editor-drag">&#9776;</span>' : '<span class="col-editor-drag" style="visibility:hidden;">&#9776;</span>') +
        '<label class="col-editor-label">' +
        '<input type="checkbox" ' + (checked ? 'checked' : '') + ' ' + (locked ? 'disabled' : '') + ' data-key="' + key + '"> ' +
        col.label +
        '</label>' +
        '</div>';
    }
    html += '</div>';
    html += '<button class="col-editor-reset">Reset to Default</button>';
    this._panel.innerHTML = html;

    // Checkbox events
    this._panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.key;
        if (cb.checked) {
          this.hidden.delete(key);
        } else {
          this.hidden.add(key);
        }
        this._save();
        if (this.onColumnsChange) this.onColumnsChange();
      });
    });

    // Reset
    this._panel.querySelector('.col-editor-reset').addEventListener('click', () => {
      this.reset();
    });

    // Drag and drop
    const items = this._panel.querySelectorAll('.col-editor-item[draggable="true"]');
    items.forEach(item => {
      item.addEventListener('dragstart', (e) => {
        this.dragIndex = parseInt(item.dataset.index);
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        this.dragIndex = null;
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over');
      });
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const toIndex = parseInt(item.dataset.index);
        if (this.dragIndex !== null && this.dragIndex !== toIndex) {
          const [moved] = this.order.splice(this.dragIndex, 1);
          this.order.splice(toIndex, 0, moved);
          this._syncOrder();
          this._save();
          this._renderPanel();
          if (this.onColumnsChange) this.onColumnsChange();
        }
      });
    });
  }

  reset() {
    localStorage.removeItem(this.storageKey);
    this._defaults();
    this._save();
    this._renderPanel();
    if (this.onColumnsChange) this.onColumnsChange();
  }
}

// Page size selector — allows user to choose 25/50/100 rows per page
function getPageSize(pageId, defaultSize) {
  var saved = localStorage.getItem('pageSize_' + pageId);
  return saved ? parseInt(saved, 10) : (defaultSize || 50);
}

function renderPageSizeSelector(pageId, currentSize, onChange) {
  var sizes = [25, 50, 100];
  var html = '<div class="page-size-selector"><span>Show</span>';
  for (var i = 0; i < sizes.length; i++) {
    var s = sizes[i];
    html += '<button' + (s === currentSize ? ' class="active"' : '') +
      ' data-size="' + s + '">' + s + '</button>';
  }
  html += '<span>per page</span></div>';

  var container = document.createElement('div');
  container.innerHTML = html;
  var el = container.firstChild;

  el.querySelectorAll('button').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var size = parseInt(btn.dataset.size, 10);
      localStorage.setItem('pageSize_' + pageId, size);
      el.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      if (onChange) onChange(size);
    });
  });

  return el;
}

// Global timezone loader — fetched once, shared by all functions
let __tz = '';
const __tzReady = fetch('/api/settings').then(r => r.ok ? r.json() : {}).then(d => { __tz = d.timezone || ''; }).catch(() => {});
function getConfiguredTz() { return __tz || 'America/New_York'; }

// Live clock + date in page header (uses timezone from system settings)
function initClock() {
  const header = document.querySelector('.page-header');
  if (!header) return;

  const clock = document.createElement('div');
  clock.id = 'liveClock';
  clock.style.cssText = 'text-align:right;font-size:0.85rem;color:var(--gray-500);line-height:1.4;white-space:nowrap;';
  header.appendChild(clock);

  function tick() {
    const now = new Date();
    const tz = getConfiguredTz();
    const date = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz });
    clock.innerHTML = '<div style="font-weight:600;color:var(--gray-700);font-size:0.95rem;">' + time + '</div>' +
      '<div>' + date + ' &middot; ' + tz + '</div>';
  }

  tick();
  setInterval(tick, 1000);
}

// Run auth check and clock on page load
checkAuth();
initClock();

// ===== Global quick finder (Cmd/Ctrl+K on every admin screen) =====
// Searches landing pages by name/slug (jumps straight into the edit dialog)
// and admin screens by name. One consistent way to find anything.
(function () {
  const QF_SCREENS = [
    ['Dashboard', 'index.html'], ['Landing Pages', 'pages.html'], ['Leads', 'leads.html'],
    ['Affiliate Leads', 'affiliate-leads.html'], ['Forms', 'forms.html'], ['Articles', 'articles.html'],
    ['Campaigns', 'campaigns.html'], ['Conversions', 'conversions.html'], ['Visitors', 'visitors.html'],
    ['Calls', 'calls.html'], ['Pipeline', 'pipeline.html'], ['Inbox', 'inbox.html'],
    ['Engagement', 'engagement.html'], ['Google Ads', 'google-ads.html'], ['Bing Ads', 'bing-ads.html'],
    ['Meta Ads', 'meta-ads.html'], ['TikTok', 'tiktok.html'], ['Reddit', 'reddit.html'],
    ['Outbrain', 'outbrain.html'], ['Organic Traffic', 'organic.html'], ['Deep Analysis', 'deep-analysis.html'],
    ['RedTrack', 'redtrack.html'], ['Google Sheet', 'google-sheet.html'], ['Email Campaigns', 'email-campaigns.html'],
    ['Email Templates', 'email-templates.html'], ['Email Segments', 'email-segments.html'],
    ['Ad Generator', 'ad-generator.html'], ['UTM Builder', 'utm-builder.html'], ['Scripts', 'scripts.html'],
    ['Users', 'users.html'], ['Settings', 'settings.html'], ['Platform Settings', 'platform-settings.html']
  ];
  let qfPages = null;
  let qfSel = 0;
  let qfItems = [];

  async function qfLoadPages() {
    if (qfPages) return qfPages;
    try {
      const res = await fetch('/api/pages');
      const data = await res.json();
      qfPages = (Array.isArray(data) ? data : []).map(p => ({ id: p.id, name: p.name || '', slug: p.slug || '' }));
    } catch (e) { qfPages = []; }
    return qfPages;
  }

  function qfEnsureDom() {
    if (document.getElementById('qfOverlay')) return;
    const el = document.createElement('div');
    el.id = 'qfOverlay';
    el.innerHTML = '<div class="qf-box">' +
      '<input id="qfInput" type="text" placeholder="Find a landing page or screen..." autocomplete="off">' +
      '<div id="qfResults"></div>' +
      '<div class="qf-hint">&#8593;&#8595; navigate &middot; Enter open &middot; Esc close</div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('mousedown', function (e) { if (e.target === el) qfClose(); });
    document.getElementById('qfInput').addEventListener('input', function () { qfRender(this.value); });
    document.getElementById('qfInput').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); qfMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); qfMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); qfGo(); }
    });
  }

  function qfMove(d) {
    if (!qfItems.length) return;
    qfSel = (qfSel + d + qfItems.length) % qfItems.length;
    const rows = document.querySelectorAll('.qf-item');
    rows.forEach((r, i) => r.classList.toggle('sel', i === qfSel));
    if (rows[qfSel]) rows[qfSel].scrollIntoView({ block: 'nearest' });
  }

  function qfGo() {
    const it = qfItems[qfSel];
    if (it) window.location.href = it.href;
  }

  function qfRender(q) {
    const box = document.getElementById('qfResults');
    q = (q || '').toLowerCase().trim();
    const pages = (qfPages || [])
      .filter(p => !q || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
      .slice(0, 8)
      .map(p => ({ label: p.name, sub: '/lp/' + p.slug + '/', href: 'pages.html?edit=' + p.id, kind: 'Page' }));
    const screens = QF_SCREENS
      .filter(s => !q || s[0].toLowerCase().includes(q))
      .slice(0, q ? 5 : 3)
      .map(s => ({ label: s[0], sub: 'screen', href: s[1], kind: 'Screen' }));
    qfItems = pages.concat(screens);
    qfSel = 0;
    box.innerHTML = qfItems.length
      ? qfItems.map((it, i) =>
          '<div class="qf-item' + (i === 0 ? ' sel' : '') + '" data-i="' + i + '">' +
          '<span class="qf-kind ' + (it.kind === 'Page' ? 'qf-kind-page' : 'qf-kind-screen') + '">' + it.kind + '</span>' +
          '<span class="qf-label">' + escapeHtml(it.label) + '</span>' +
          '<span class="qf-sub">' + escapeHtml(it.sub) + '</span></div>'
        ).join('')
      : '<div class="qf-empty">Nothing found</div>';
    box.querySelectorAll('.qf-item').forEach(r => {
      r.addEventListener('click', function () { qfSel = parseInt(this.dataset.i); qfGo(); });
      r.addEventListener('mousemove', function () {
        qfSel = parseInt(this.dataset.i);
        box.querySelectorAll('.qf-item').forEach((x, i) => x.classList.toggle('sel', i === qfSel));
      });
    });
  }

  window.openQuickFinder = async function () {
    qfEnsureDom();
    document.getElementById('qfOverlay').classList.add('open');
    const input = document.getElementById('qfInput');
    input.value = '';
    qfRender('');
    input.focus();
    await qfLoadPages();
    qfRender(input.value);
  };
  function qfClose() {
    const el = document.getElementById('qfOverlay');
    if (el) el.classList.remove('open');
  }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 'k') { e.preventDefault(); openQuickFinder(); }
    else if (e.key === 'Escape') qfClose();
  });

  document.addEventListener('DOMContentLoaded', function () {
    const nav = document.querySelector('.sidebar-nav');
    if (nav && !document.getElementById('qfNavBtn')) {
      const btn = document.createElement('button');
      btn.id = 'qfNavBtn';
      btn.type = 'button';
      btn.innerHTML = '<span>&#128269; Find page...</span><kbd>&#8984;K</kbd>';
      btn.addEventListener('click', function () { openQuickFinder(); });
      nav.insertBefore(btn, nav.firstChild);
    }
  });
})();
