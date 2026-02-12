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

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'API Error');
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
    const y = toLocalDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    return { from: y, to: y };
  }
  let from;
  if (range === 'last_week') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  } else if (range === '7d') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  } else if (range === '30d') {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  } else if (range === 'mtd') {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    return { from: '', to: '' };
  }
  return { from: toLocalDate(from), to: today };
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
    return this.getVisibleColumns().map(k => '<th>' + (colMap[k] ? colMap[k].label : k) + '</th>').join('');
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
