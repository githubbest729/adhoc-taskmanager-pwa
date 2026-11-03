/* AdHoc TaskManager — app.js
 * Vanilla ES2020. Offline-first: IndexedDB (localStorage fallback), service worker,
 * state machine for task lifecycle, report/CSV generator, backup/restore.
 */
'use strict';

(() => {
  /* =====================================================================
   * 1. Config & helpers
   * ===================================================================== */
  const APP = Object.freeze({ name: 'AdHoc TaskManager', version: '1.0.0', db: 'adhoc-taskmanager', dbVersion: 1 });

  const URGENCY = Object.freeze({
    blocker: { label: 'Blocker / Critical', short: 'Blocker', hint: 'Drop everything', rank: 0, glyph: '‼' },
    standard: { label: 'Standard Ad-Hoc', short: 'Standard', hint: 'Normal queue', rank: 1, glyph: '●' },
    low: { label: 'Low Priority / End of Day', short: 'Low', hint: 'Wrap up later', rank: 2, glyph: '○' }
  });
  const DEFAULT_REQUESTERS = ['Project Manager', 'Lead Controls Eng', 'Operations Manager', 'Client Rep'];
  const CONTEXTS = ['SCADA/HMI Fix', 'PLC Logic', 'SQL/Database', 'Site Survey/BOM', 'Client Coordination', 'HSE/Documentation', 'Unplanned Troubleshooting'];
  const VIEWS = {
    inbox: { title: 'Inbox' },
    progress: { title: 'In Progress / Commissioning' },
    done: { title: 'Completed / Closed Archive' }
  };
  const MAX_AUDIO_SECONDS = 120;
  const DRAFT_KEY = 'adhoc.draft.v1';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const pad = (n) => String(n).padStart(2, '0');
  const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max);
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name, cls = 'i') {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('class', cls);
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', `#i-${name}`);
    s.append(u);
    return s;
  }

  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  };
  const fmtHM = (ms) => {
    const m = Math.round(Math.max(0, ms) / 60000);
    const hh = Math.floor(m / 60), mm = m % 60;
    return hh ? `${hh}h ${pad(mm)}m` : `${mm}m`;
  };
  const hoursDec = (ms) => (Math.max(0, ms) / 3600000).toFixed(2);
  const isoDate = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const fmtDateTime = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtDay = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const fmtShort = (ts) => new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  function relTime(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    if (m < 1440) return `${Math.floor(m / 60)}h ago`;
    return fmtShort(ts);
  }
  const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const startOfWeek = (ts) => { const d = new Date(startOfDay(ts)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
  const startOfMonth = (ts) => { const d = new Date(startOfDay(ts)); d.setDate(1); return d.getTime(); };

  /* =====================================================================
   * 2. Persistence (IndexedDB with localStorage fallback)
   * ===================================================================== */
  const Storage = (() => {
    let db = null;
    let mode = 'idb';
    const LS = { tasks: 'adhoc.tasks.v1', meta: 'adhoc.meta.v1' };

    const lsRead = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } };
    const lsWrite = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { throw new Error('Local storage is full or blocked'); } };
    const stripAudio = (t) => { const { audio, ...rest } = t; return rest; };

    function openIDB() {
      return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
        let req;
        try { req = indexedDB.open(APP.db, APP.dbVersion); } catch (e) { return reject(e); }
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('tasks')) d.createObjectStore('tasks', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
      });
    }

    const tx = (stores, access, work) => new Promise((resolve, reject) => {
      let result;
      const t = db.transaction(stores, access);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction aborted'));
      work(t, (v) => { result = v; });
    });

    return {
      get mode() { return mode; },
      async init() {
        try {
          db = await openIDB();
          db.onversionchange = () => db.close();
          mode = 'idb';
        } catch (e) {
          console.warn('[storage] falling back to localStorage:', e);
          mode = 'ls';
        }
        return mode;
      },
      async allTasks() {
        if (mode === 'ls') return lsRead(LS.tasks, []);
        return tx('tasks', 'readonly', (t, set) => { const r = t.objectStore('tasks').getAll(); r.onsuccess = () => set(r.result); });
      },
      async putTask(task) {
        if (mode === 'ls') {
          const all = lsRead(LS.tasks, []);
          const i = all.findIndex((x) => x.id === task.id);
          if (i >= 0) all[i] = stripAudio(task); else all.push(stripAudio(task));
          return lsWrite(LS.tasks, all);
        }
        return tx('tasks', 'readwrite', (t) => { t.objectStore('tasks').put(task); });
      },
      async putMany(list) {
        if (mode === 'ls') {
          const map = new Map(lsRead(LS.tasks, []).map((x) => [x.id, x]));
          list.forEach((x) => map.set(x.id, stripAudio(x)));
          return lsWrite(LS.tasks, [...map.values()]);
        }
        return tx('tasks', 'readwrite', (t) => { const s = t.objectStore('tasks'); list.forEach((x) => s.put(x)); });
      },
      async deleteTask(id) {
        if (mode === 'ls') return lsWrite(LS.tasks, lsRead(LS.tasks, []).filter((x) => x.id !== id));
        return tx('tasks', 'readwrite', (t) => { t.objectStore('tasks').delete(id); });
      },
      async clearTasks() {
        if (mode === 'ls') return lsWrite(LS.tasks, []);
        return tx('tasks', 'readwrite', (t) => { t.objectStore('tasks').clear(); });
      },
      async getMeta() {
        if (mode === 'ls') return lsRead(LS.meta, null);
        return tx('meta', 'readonly', (t, set) => { const r = t.objectStore('meta').get('app'); r.onsuccess = () => set(r.result || null); });
      },
      async setMeta(meta) {
        if (mode === 'ls') return lsWrite(LS.meta, meta);
        return tx('meta', 'readwrite', (t) => { t.objectStore('meta').put(meta, 'app'); });
      }
    };
  })();

  /* =====================================================================
   * 3. State, task model & lifecycle state machine
   * ===================================================================== */
  const state = {
    tasks: new Map(),
    view: 'inbox',
    query: '',
    ctx: '',
    scopeOnly: false,
    detailId: null,
    completeId: null,
    editingId: null,
    ready: false,
    audioUrl: null,
    offlineReady: false,
    persistAsked: false,
    meta: { engineer: '', requesters: [...DEFAULT_REQUESTERS], theme: 'auto', contrast: false, group: 'urgency', lastRequester: '', lastContext: '', reportRange: 'week' }
  };

  function newTask() {
    const now = Date.now();
    return {
      id: uid(), title: '', note: '', assignedBy: 'Unspecified', context: 'Unspecified', urgency: 'standard', scope: false,
      status: 'inbox', createdAt: now, updatedAt: now, startedAt: null, accumulatedMs: 0, closedAt: null, resolution: '', audio: null
    };
  }

  function sanitizeTask(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const title = str(raw.title, 200);
    if (!title) return null;
    const status = ['inbox', 'progress', 'done'].includes(raw.status) ? raw.status : 'inbox';
    const createdAt = num(raw.createdAt, Date.now());
    return {
      id: str(raw.id, 64) || uid(),
      title,
      note: str(raw.note, 4000),
      assignedBy: str(raw.assignedBy, 80) || 'Unspecified',
      context: str(raw.context, 80) || 'Unspecified',
      urgency: hasOwn(URGENCY, raw.urgency) ? raw.urgency : 'standard',
      scope: !!raw.scope,
      status,
      createdAt,
      updatedAt: num(raw.updatedAt, createdAt),
      startedAt: status === 'progress' && raw.startedAt ? num(raw.startedAt, null) : null,
      accumulatedMs: Math.max(0, num(raw.accumulatedMs)),
      closedAt: status === 'done' ? num(raw.closedAt, createdAt) : null,
      resolution: str(raw.resolution, 2000),
      audio: typeof Blob !== 'undefined' && raw.audio instanceof Blob ? raw.audio : null
    };
  }

  const elapsed = (t, now = Date.now()) => t.accumulatedMs + (t.startedAt ? Math.max(0, now - t.startedAt) : 0);
  const bank = (t, now) => { if (t.startedAt) { t.accumulatedMs += Math.max(0, now - t.startedAt); t.startedAt = null; } };

  const TRANSITIONS = {
    start: { from: ['inbox', 'progress'], apply: (t, now) => { if (!t.startedAt) t.startedAt = now; t.status = 'progress'; } },
    pause: { from: ['progress'], apply: (t, now) => bank(t, now) },
    shelve: { from: ['progress'], apply: (t, now) => { bank(t, now); t.status = 'inbox'; } },
    complete: {
      from: ['inbox', 'progress'],
      apply: (t, now, p = {}) => {
        bank(t, now);
        t.accumulatedMs = Math.max(0, t.accumulatedMs + (p.adjustMs || 0));
        t.status = 'done';
        t.closedAt = now;
        t.resolution = str(p.resolution, 2000) || 'Completed';
      }
    },
    reopen: { from: ['done'], apply: (t) => { t.status = 'inbox'; t.closedAt = null; t.startedAt = null; } }
  };

  async function saveTask(t) {
    t.updatedAt = Date.now();
    state.tasks.set(t.id, t);
    try {
      await Storage.putTask(t);
      requestPersistence();
      return true;
    } catch (e) {
      console.error(e);
      toast('Could not save — storage error. Export a backup if you can.', { kind: 'error' });
      return false;
    }
  }

  const saveMeta = debounce(() => { Storage.setMeta(state.meta).catch((e) => console.error('[meta]', e)); }, 200);

  async function transition(id, name, payload) {
    const t = state.tasks.get(id);
    const tr = TRANSITIONS[name];
    if (!t || !tr || !tr.from.includes(t.status)) return false;
    const now = Date.now();
    if (name === 'start') {
      for (const o of state.tasks.values()) {
        if (o.id !== id && o.startedAt) { bank(o, now); await saveTask(o); } // one running timer at a time
      }
    }
    tr.apply(t, now, payload);
    const ok = await saveTask(t);
    buzz();
    render();
    return ok;
  }

  async function deleteTask(id) {
    const t = state.tasks.get(id);
    if (!t) return;
    state.tasks.delete(id);
    try { await Storage.deleteTask(id); } catch (e) { console.error(e); }
    render();
    toast('Task deleted', { action: { label: 'Undo', fn: async () => { state.tasks.set(t.id, t); await saveTask(t); render(); } }, timeout: 6000 });
  }

  function requestPersistence() {
    if (state.persistAsked || !navigator.storage || !navigator.storage.persist) return;
    state.persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }
  const buzz = () => { try { navigator.vibrate && navigator.vibrate(15); } catch (_) { /* optional */ } };

  /* =====================================================================
   * 4. Toasts & dialog helpers
   * ===================================================================== */
  function toast(msg, { kind = 'info', action = null, timeout = 4500 } = {}) {
    const host = $('#toasts');
    const el = h('div', { class: `toast t-${kind}` },
      h('span', {}, msg),
      action && h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { try { action.fn(); } finally { el.remove(); } } }, action.label));
    host.append(el);
    while (host.children.length > 3) host.firstChild.remove();
    if (timeout) setTimeout(() => el.remove(), timeout);
    return el;
  }

  function openDialog(d) {
    if (!d || d.open) return;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }
  function closeDialog(sel) {
    const d = typeof sel === 'string' ? $(sel) : sel;
    if (d && d.open) { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); }
  }
  const anyDialogOpen = () => $$('dialog').some((d) => d.open);
  const announce = (msg) => { $('#sr-status').textContent = msg; };

  /* =====================================================================
   * 6. Theme
   * ===================================================================== */
  const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
  const mqContrast = window.matchMedia('(prefers-contrast: more)');
  function applyTheme() {
    const { theme, contrast } = state.meta;
    const scheme = theme === 'auto' ? (mqDark.matches ? 'dark' : 'light') : theme;
    const high = contrast || mqContrast.matches;
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.scheme = scheme;
    root.dataset.contrast = high ? 'high' : 'normal';
    const color = high ? (scheme === 'dark' ? '#000000' : '#ffffff') : (scheme === 'dark' ? '#0f172a' : '#f1f5f9');
    const m = $('#meta-theme');
    if (m) m.content = color;
    try { localStorage.setItem('adhoc.theme', theme); localStorage.setItem('adhoc.contrast', contrast ? '1' : '0'); } catch (_) { /* optional */ }
  }

  /* =====================================================================
   * 7. Rendering
   * ===================================================================== */
  const haystack = (t) => [t.title, t.note, t.assignedBy, t.context, t.resolution].join(' ').toLowerCase();

  function visibleTasks() {
    const q = state.query.trim().toLowerCase();
    return [...state.tasks.values()].filter((t) =>
      t.status === state.view &&
      (!state.ctx || t.context === state.ctx) &&
      (!state.scopeOnly || t.scope) &&
      (!q || haystack(t).includes(q)));
  }

  function groupTasks(list) {
    if (state.view === 'inbox') {
      const by = state.meta.group;
      list.sort((a, b) => URGENCY[a.urgency].rank - URGENCY[b.urgency].rank || b.createdAt - a.createdAt);
      const map = new Map();
      for (const t of list) {
        const key = by === 'requester' ? t.assignedBy : t.urgency;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(t);
      }
      let keys = [...map.keys()];
      keys = by === 'requester' ? keys.sort((a, b) => a.localeCompare(b)) : keys.sort((a, b) => URGENCY[a].rank - URGENCY[b].rank);
      return keys.map((k) => ({ key: k, label: by === 'requester' ? k : URGENCY[k].label, items: map.get(k) }));
    }
    if (state.view === 'progress') {
      list.sort((a, b) => (b.startedAt ? 1 : 0) - (a.startedAt ? 1 : 0) || URGENCY[a.urgency].rank - URGENCY[b.urgency].rank || b.updatedAt - a.updatedAt);
      return list.length ? [{ key: 'active', label: 'Active now', items: list }] : [];
    }
    list.sort((a, b) => b.closedAt - a.closedAt);
    const days = new Map();
    for (const t of list) {
      const k = fmtDay(t.closedAt);
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(t);
    }
    return [...days.entries()].map(([label, items]) => ({ key: label, label: `Closed ${label}`, items }));
  }

  const actBtn = (id, action, label, ic, cls = 'btn-ghost') =>
    h('button', { type: 'button', class: `btn ${cls}`, dataset: { action, id } }, icon(ic), label);

  function actionsFor(t) {
    const running = !!t.startedAt;
    const kids = [];
    if (t.status === 'inbox') kids.push(actBtn(t.id, 'start', 'Start', 'play', 'btn-primary'), actBtn(t.id, 'complete', 'Done', 'check'));
    else if (t.status === 'progress') kids.push(running ? actBtn(t.id, 'pause', 'Pause', 'pause', 'btn-secondary') : actBtn(t.id, 'start', 'Resume', 'play', 'btn-primary'), actBtn(t.id, 'complete', 'Done', 'check', running ? 'btn-primary' : 'btn-ghost'));
    else kids.push(actBtn(t.id, 'reopen', 'Reopen', 'undo'));
    return h('div', { class: 'task-actions' }, kids);
  }

  function badgesFor(t) {
    const u = URGENCY[t.urgency];
    const running = !!t.startedAt;
    return h('div', { class: 'task-badges' },
      h('span', { class: `badge b-${t.urgency}` }, h('span', { 'aria-hidden': 'true' }, u.glyph), u.short),
      t.scope && h('span', { class: 'badge b-scope' }, icon('alert'), 'Change order'),
      t.audio && h('span', { class: 'badge b-muted' }, icon('mic'), 'Audio'),
      t.status === 'progress' && h('span', { class: `badge ${running ? 'b-run' : 'b-muted'}` }, running ? 'Running' : 'Paused'));
  }

  function taskCard(t) {
    return h('article', { class: `task u-${t.urgency}`, dataset: { id: t.id } },
      badgesFor(t),
      h('h3', { class: 'task-title' }, h('button', { type: 'button', class: 'link-btn', dataset: { action: 'open', id: t.id } }, t.title)),
      h('p', { class: 'task-meta' }, `${t.assignedBy} · ${t.context} · ${relTime(t.createdAt)}`),
      t.note && h('p', { class: 'task-note' }, t.note),
      t.status === 'progress' && h('p', { class: 'task-timer' }, icon('clock'), h('span', { class: 'timer', dataset: { timerId: t.id } }, fmtClock(elapsed(t)))),
      t.status === 'done' && h('p', { class: 'task-done' }, `Spent ${fmtHM(elapsed(t))} · Closed ${fmtDateTime(t.closedAt)}`),
      t.status === 'done' && h('p', { class: 'task-resolution' }, h('strong', {}, 'Resolution: '), t.resolution),
      actionsFor(t));
  }

  function emptyState() {
    const filtered = state.query || state.ctx || state.scopeOnly;
    if (filtered && [...state.tasks.values()].some((t) => t.status === state.view)) {
      return h('div', { class: 'empty' }, icon('search'), h('h3', {}, 'No matches'), h('p', {}, 'Nothing in this view fits the current search or filters.'),
        h('button', { type: 'button', class: 'btn btn-secondary', dataset: { action: 'clear-filters' } }, 'Clear filters'));
    }
    const copy = {
      inbox: ['Inbox zero', 'No ad-hoc requests waiting. When a manager drops something on you, tap Quick add and capture it in seconds.'],
      progress: ['Nothing in progress', 'Start a task from the Inbox to run a timer and log hours diverted from planned scope.'],
      done: ['No closed tasks yet', 'Close a task with a resolution note to build your Task 28 log for the manager report.']
    }[state.view];
    return h('div', { class: 'empty' }, icon(state.view === 'done' ? 'check' : state.view === 'progress' ? 'clock' : 'inbox'), h('h3', {}, copy[0]), h('p', {}, copy[1]),
      state.view === 'inbox' && h('button', { type: 'button', class: 'btn btn-primary', dataset: { action: 'new' } }, icon('plus'), 'Quick add'));
  }

  function renderSkeleton() {
    $('#list').replaceChildren(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  }

  function renderList() {
    const host = $('#list');
    const groups = groupTasks(visibleTasks());
    host.setAttribute('aria-busy', 'false');
    host.replaceChildren();
    $('#view-title').textContent = VIEWS[state.view].title;
    $('#grp-wrap').hidden = state.view !== 'inbox';
    if (!groups.length) {
      host.append(emptyState());
      announce(`No tasks in ${VIEWS[state.view].title}`);
      return;
    }
    let total = 0;
    for (const g of groups) {
      total += g.items.length;
      host.append(h('section', { class: 'group', 'aria-label': g.label },
        h('h3', { class: 'group-title' }, g.label, h('span', { class: 'count' }, String(g.items.length))),
        g.items.map(taskCard)));
    }
    announce(`${total} task${total === 1 ? '' : 's'} in ${VIEWS[state.view].title}`);
  }

  function renderStats() {
    const all = [...state.tasks.values()];
    const now = Date.now();
    const wk = startOfWeek(now);
    const week = all.filter((t) => t.createdAt >= wk || (t.closedAt && t.closedAt >= wk));
    const count = (s) => all.filter((t) => t.status === s).length;
    $('#stat-open').textContent = count('inbox');
    $('#stat-active').textContent = count('progress');
    $('#stat-hours').textContent = hoursDec(week.reduce((a, t) => a + elapsed(t, now), 0));
    $('#stat-scope').textContent = week.filter((t) => t.scope).length;
    $('#count-inbox').textContent = count('inbox');
    $('#count-progress').textContent = count('progress');
    $('#count-done').textContent = count('done');
  }

  function renderTabs() {
    $$('.tab').forEach((b) => {
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  function render() {
    renderStats();
    renderTabs();
    renderList();
    if (state.detailId && $('#dlg-task').open) renderDetail();
  }

  function tick() {
    const now = Date.now();
    for (const el of $$('[data-timer-id]')) {
      const t = state.tasks.get(el.dataset.timerId);
      if (t) el.textContent = fmtClock(elapsed(t, now));
    }
    renderStats();
  }

  function setView(v) {
    if (!hasOwn(VIEWS, v)) return;
    state.view = v;
    render();
    window.scrollTo({ top: 0 });
  }

  /* =====================================================================
   * 8. Task detail & completion
   * ===================================================================== */
  const kv = (label, value) => h('div', { class: 'kv-row' }, h('dt', {}, label), h('dd', {}, value));

  function revokeAudioUrl() {
    if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = null; }
  }

  function openDetail(id) {
    state.detailId = id;
    renderDetail();
    openDialog($('#dlg-task'));
  }

  function renderDetail() {
    const t = state.tasks.get(state.detailId);
    if (!t) { closeDialog('#dlg-task'); return; }
    revokeAudioUrl();
    const u = URGENCY[t.urgency];
    const body = $('#task-detail');
    let audioBlock = null;
    if (t.audio) {
      state.audioUrl = URL.createObjectURL(t.audio);
      audioBlock = h('div', { class: 'note-block' }, h('h3', {}, 'Audio note'), h('audio', { controls: true, src: state.audioUrl, preload: 'metadata' }));
    }
    body.replaceChildren(
      badgesFor(t),
      h('p', { class: 'detail-title' }, t.title),
      h('dl', { class: 'kv' },
        kv('Assigned by', t.assignedBy),
        kv('Context', t.context),
        kv('Urgency', u.label),
        kv('Scope', t.scope ? 'Billable scope creep — needs change order' : 'Within planned scope'),
        kv('Captured', fmtDateTime(t.createdAt)),
        kv('Time spent', t.status === 'done' ? fmtHM(elapsed(t)) : h('span', { class: 'timer', dataset: { timerId: t.id } }, fmtClock(elapsed(t)))),
        t.status === 'done' && kv('Closed', fmtDateTime(t.closedAt)),
        t.resolution && kv('Resolution', t.resolution)),
      t.note && h('div', { class: 'note-block' }, h('h3', {}, 'Raw note'), h('p', { class: 'pre' }, t.note)),
      audioBlock);

    const acts = [];
    if (t.status === 'inbox') acts.push(actBtn(t.id, 'start', 'Start', 'play', 'btn-primary'), actBtn(t.id, 'complete', 'Done', 'check', 'btn-secondary'));
    else if (t.status === 'progress') {
      acts.push(t.startedAt ? actBtn(t.id, 'pause', 'Pause', 'pause', 'btn-secondary') : actBtn(t.id, 'start', 'Resume', 'play', 'btn-primary'),
        actBtn(t.id, 'complete', 'Done', 'check', t.startedAt ? 'btn-primary' : 'btn-secondary'),
        actBtn(t.id, 'shelve', 'Back to inbox', 'inbox'));
    } else acts.push(actBtn(t.id, 'reopen', 'Reopen', 'undo', 'btn-secondary'));
    acts.push(actBtn(t.id, 'edit', 'Edit', 'edit'), actBtn(t.id, 'delete', 'Delete', 'trash', 'btn-danger'));
    $('#task-actions').replaceChildren(...acts);
  }

  function openComplete(id) {
    const t = state.tasks.get(id);
    if (!t) return;
    state.completeId = id;
    $('#c-summary').textContent = `“${t.title}” — tracked so far: ${fmtHM(elapsed(t))}.`;
    $('#c-resolution').value = '';
    $('#c-adjust').value = '0';
    openDialog($('#dlg-complete'));
    $('#c-resolution').focus();
  }

  async function onCompleteSubmit(e) {
    e.preventDefault();
    const id = state.completeId;
    if (!id) return;
    const mins = Math.max(-1440, Math.min(1440, num($('#c-adjust').value, 0)));
    const ok = await transition(id, 'complete', { resolution: $('#c-resolution').value, adjustMs: mins * 60000 });
    if (ok) {
      const t = state.tasks.get(id);
      closeDialog('#dlg-complete');
      closeDialog('#dlg-task');
      toast(`Closed · ${fmtHM(elapsed(t))} logged`, { kind: 'ok' });
    }
  }

  async function handleAction(action, id) {
    switch (action) {
      case 'open': openDetail(id); break;
      case 'start': await transition(id, 'start'); break;
      case 'pause': await transition(id, 'pause'); break;
      case 'shelve': await transition(id, 'shelve'); break;
      case 'complete': openComplete(id); break;
      case 'reopen': await transition(id, 'reopen'); toast('Moved back to Inbox'); break;
      case 'edit': closeDialog('#dlg-task'); openCapture(id); break;
      case 'delete': closeDialog('#dlg-task'); await deleteTask(id); break;
      case 'new': openCapture(); break;
      case 'clear-filters':
        state.query = ''; state.ctx = ''; state.scopeOnly = false;
        $('#q').value = ''; $('#f-context-filter').value = ''; $('#f-scope-only').checked = false;
        render();
        break;
      default: break;
    }
  }

  /* =====================================================================
   * 9. Quick-capture sheet (incl. voice: dictation + audio recording)
   * ===================================================================== */
  let pendingAudio = null;
  let audioChanged = false;
  let recorder = null, recStream = null, recChunks = [], recTimer = null, recStarted = 0, recDiscard = false;
  let recognition = null, dictating = false;

  function chipGroup(host, name, options, selected) {
    host.replaceChildren(...options.map((opt) =>
      h('label', { class: 'chip' }, h('input', { type: 'radio', name, value: opt, checked: opt === selected || null }), h('span', {}, opt))));
  }

  function renderRequesterChips(selected) {
    const list = [...state.meta.requesters];
    if (selected && !list.includes(selected) && selected !== 'Unspecified') list.push(selected);
    const host = $('#chips-requester');
    chipGroup(host, 'requester', list, selected);
    host.append(h('button', { type: 'button', class: 'chip-add', onclick: toggleNewRequester }, icon('plus'), 'Other'));
  }

  function toggleNewRequester() {
    const wrap = $('#requester-new-wrap');
    wrap.hidden = !wrap.hidden;
    if (!wrap.hidden) $('#f-requester-new').focus();
  }

  function addRequester() {
    const input = $('#f-requester-new');
    const name = str(input.value, 80);
    if (!name) { input.focus(); return; }
    const existing = state.meta.requesters.find((r) => r.toLowerCase() === name.toLowerCase());
    if (!existing) { state.meta.requesters.push(name); saveMeta(); }
    input.value = '';
    $('#requester-new-wrap').hidden = true;
    renderRequesterChips(existing || name);
    $('#capture-form').dispatchEvent(new Event('change', { bubbles: true }));
  }

  function urgencyGroup(host, selected) {
    host.replaceChildren(...Object.entries(URGENCY).map(([k, u]) =>
      h('label', { class: `urg u-${k}` },
        h('input', { type: 'radio', name: 'urgency', value: k, checked: k === selected || null }),
        h('span', { class: 'urg-body' },
          h('span', { class: 'urg-glyph', 'aria-hidden': 'true' }, u.glyph),
          h('span', {}, h('strong', {}, u.label), h('small', {}, u.hint))))));
  }

  function readForm() {
    const fd = new FormData($('#capture-form'));
    const urg = fd.get('urgency');
    return {
      title: str(fd.get('title'), 200),
      note: str(fd.get('note'), 4000),
      assignedBy: str(fd.get('requester'), 80),
      context: str(fd.get('context'), 80),
      urgency: hasOwn(URGENCY, urg) ? urg : 'standard',
      scope: $('#f-scope').checked
    };
  }

  const loadDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) { return null; } };
  const clearDraft = () => { try { localStorage.removeItem(DRAFT_KEY); } catch (_) { /* optional */ } };
  const saveDraft = debounce(() => {
    if (state.editingId) return;
    const d = readForm();
    if (!d.title && !d.note) { clearDraft(); return; }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch (_) { /* optional */ }
  }, 300);

  function showError(msg) {
    const p = $('#capture-error');
    p.textContent = msg;
    p.hidden = !msg;
  }

  function setAudio(blob, changed = false) {
    pendingAudio = blob || null;
    audioChanged = audioChanged || changed;
    const wrap = $('#audio-wrap');
    const el = $('#f-audio');
    if (el.dataset.url) { URL.revokeObjectURL(el.dataset.url); delete el.dataset.url; }
    if (pendingAudio) {
      const url = URL.createObjectURL(pendingAudio);
      el.dataset.url = url;
      el.src = url;
      wrap.hidden = false;
    } else {
      el.removeAttribute('src');
      wrap.hidden = true;
    }
  }

  function openCapture(editId = null) {
    const t = editId ? state.tasks.get(editId) : null;
    state.editingId = t ? t.id : null;
    audioChanged = false;
    showError('');
    const v = t || loadDraft() || {};
    $('#capture-heading').textContent = t ? 'Edit task' : 'Quick capture';
    $('#f-title').value = v.title || '';
    $('#f-note').value = v.note || '';
    $('#f-scope').checked = !!v.scope;
    $('#requester-new-wrap').hidden = true;
    renderRequesterChips(v.assignedBy && v.assignedBy !== 'Unspecified' ? v.assignedBy : (t ? '' : state.meta.lastRequester));
    chipGroup($('#chips-context'), 'context', CONTEXTS, v.context && v.context !== 'Unspecified' ? v.context : (t ? '' : state.meta.lastContext));
    urgencyGroup($('#chips-urgency'), v.urgency || 'standard');
    setAudio(t ? t.audio : null);
    $('#btn-save').textContent = t ? 'Save changes' : 'Save to Inbox';
    $('#btn-save-start').hidden = !!t;
    openDialog($('#dlg-capture'));
    $('#f-title').focus();
  }

  async function onCaptureSubmit(e) {
    e.preventDefault();
    const start = !!(e.submitter && e.submitter.value === 'start');
    const d = readForm();
    let title = d.title;
    if (!title && d.note) title = d.note.split(/\n/)[0].slice(0, 120);
    if (!title) {
      showError('Enter a task title or a quick note so you can find it later.');
      $('#f-title').focus();
      return;
    }
    const existing = state.editingId ? state.tasks.get(state.editingId) : null;
    const t = existing || newTask();
    Object.assign(t, {
      title: str(title, 200), note: d.note, assignedBy: d.assignedBy || 'Unspecified',
      context: d.context || 'Unspecified', urgency: d.urgency, scope: d.scope
    });
    if (!existing || audioChanged) t.audio = pendingAudio;
    if (!(await saveTask(t))) return;
    if (d.assignedBy) state.meta.lastRequester = d.assignedBy;
    if (d.context) state.meta.lastContext = d.context;
    saveMeta();
    clearDraft();
    closeDialog('#dlg-capture');
    if (start && !existing) {
      await transition(t.id, 'start');
      state.view = 'progress';
      toast('Saved — timer running', { kind: 'ok' });
    } else if (existing) {
      toast('Changes saved', { kind: 'ok' });
    } else {
      state.view = 'inbox';
      toast('Captured to Inbox', { kind: 'ok' });
    }
    buzz();
    render();
  }

  /* --- Audio recording --- */
  function setRecUi(on) {
    const b = $('#btn-record');
    b.setAttribute('aria-pressed', String(on));
    b.replaceChildren(icon(on ? 'stop' : 'mic'), h('span', {}, on ? 'Stop' : 'Record audio'));
    if (!on) $('#rec-status').textContent = '';
  }

  function cleanupStream() {
    if (recStream) recStream.getTracks().forEach((tr) => tr.stop());
    recStream = null;
    clearInterval(recTimer);
  }

  async function startRecording() {
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      toast('Microphone access was blocked. Allow it in your browser settings to record.', { kind: 'error' });
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m));
    try {
      recorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
    } catch (_) {
      cleanupStream();
      toast('Audio recording is not supported on this device.', { kind: 'error' });
      return;
    }
    recChunks = [];
    recDiscard = false;
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) recChunks.push(ev.data); };
    recorder.onstop = () => {
      const type = recorder.mimeType || mime || 'audio/webm';
      cleanupStream();
      setRecUi(false);
      if (!recDiscard && recChunks.length) setAudio(new Blob(recChunks, { type }), true);
      recorder = null;
    };
    recorder.start();
    recStarted = Date.now();
    setRecUi(true);
    recTimer = setInterval(() => {
      const ms = Date.now() - recStarted;
      $('#rec-status').textContent = `● Recording ${fmtClock(ms).slice(3)}`;
      if (ms >= MAX_AUDIO_SECONDS * 1000) stopRecording(false);
    }, 250);
  }

  function stopRecording(discard) {
    recDiscard = !!discard;
    if (recorder && recorder.state !== 'inactive') recorder.stop(); else cleanupStream();
  }

  /* --- Dictation (Web Speech API, where available) --- */
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  function setDictUi(on) {
    dictating = on;
    const b = $('#btn-dictate');
    b.setAttribute('aria-pressed', String(on));
    b.replaceChildren(icon('mic'), h('span', {}, on ? 'Listening…' : 'Dictate'));
  }

  function toggleDictation() {
    if (dictating && recognition) { recognition.stop(); return; }
    recognition = new SpeechRec();
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (ev) => {
      const text = Array.from(ev.results).map((r) => r[0].transcript).join(' ').trim();
      if (!text) return;
      const f = $('#f-note');
      f.value = (f.value ? `${f.value.trimEnd()}\n` : '') + text;
      f.dispatchEvent(new Event('input', { bubbles: true }));
    };
    recognition.onerror = (ev) => {
      toast(ev.error === 'network' ? 'Dictation needs a connection on this device — use Record audio instead.' : `Dictation unavailable (${ev.error}).`, { kind: 'error' });
    };
    recognition.onend = () => setDictUi(false);
    try { recognition.start(); setDictUi(true); } catch (_) { setDictUi(false); }
  }

  /* =====================================================================
   * 10. Reports (executive summary + CSV)
   * ===================================================================== */
  function reportRange(key) {
    const now = Date.now();
    if (key === 'today') return { from: startOfDay(now), label: fmtDay(now) };
    if (key === 'week') {
      const from = startOfWeek(now);
      return { from, label: `${fmtDay(from)} – ${fmtDay(from + 6 * 86400000)}` };
    }
    if (key === 'month') return { from: startOfMonth(now), label: new Date(now).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
    return { from: 0, label: 'All time' };
  }

  function tasksInRange(from) {
    return [...state.tasks.values()]
      .filter((t) => t.createdAt >= from || (t.closedAt && t.closedAt >= from) || (t.startedAt && t.startedAt >= from))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function tally(list, keyFn) {
    const m = new Map();
    for (const t of list) {
      const k = keyFn(t);
      const e = m.get(k) || { key: k, count: 0, ms: 0 };
      e.count += 1; e.ms += elapsed(t);
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.ms - a.ms || b.count - a.count);
  }

  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  const CSV_HEAD = ['Date', 'Task', 'Assigned By', 'Hours Spent', 'Impact/Scope Flag', 'Resolution', 'Context', 'Urgency', 'Status', 'Created', 'Closed'];

  function buildReport(rangeKey) {
    const { from, label } = reportRange(rangeKey);
    const list = tasksInRange(from);
    const done = list.filter((t) => t.status === 'done');
    const open = list.filter((t) => t.status !== 'done');
    const totalMs = list.reduce((a, t) => a + elapsed(t), 0);
    const scope = list.filter((t) => t.scope);
    const blockers = list.filter((t) => t.urgency === 'blocker');
    const who = state.meta.engineer || '(name not set)';

    const L = [];
    L.push('TASK 28 — AD-HOC WORK REPORT');
    L.push('Any other work assigned by reporting manager/s');
    L.push(`Engineer: ${who}`);
    L.push(`Period: ${label}`);
    L.push(`Generated: ${new Date().toLocaleString()}`);
    L.push('');
    if (!list.length) {
      L.push('No ad-hoc tasks recorded for this period.');
    } else {
      L.push('SUMMARY');
      L.push(`• Received: ${list.length} | Closed: ${done.length} | Still open: ${open.length}`);
      L.push(`• Time diverted from planned scope: ${fmtHM(totalMs)} (${hoursDec(totalMs)} h)`);
      L.push(`• Billable scope-creep / change-order items: ${scope.length}`);
      L.push(`• Blocker / critical interruptions: ${blockers.length}`);
      L.push('');
      L.push('BY REQUESTER');
      tally(list, (t) => t.assignedBy).forEach((e) => L.push(`• ${e.key} — ${e.count} task${e.count === 1 ? '' : 's'}, ${fmtHM(e.ms)}`));
      L.push('');
      L.push('BY CONTEXT');
      tally(list, (t) => t.context).forEach((e) => L.push(`• ${e.key} — ${e.count} task${e.count === 1 ? '' : 's'}, ${fmtHM(e.ms)}`));
      if (done.length) {
        L.push('');
        L.push('COMPLETED');
        done.forEach((t, i) => {
          L.push(`${i + 1}. ${fmtShort(t.closedAt)} — ${t.title} [${t.context}] — by ${t.assignedBy} — ${fmtHM(elapsed(t))}${t.scope ? ' ⚠ CHANGE ORDER' : ''}`);
          L.push(`   Resolution: ${t.resolution || 'Completed'}`);
        });
      }
      if (open.length) {
        L.push('');
        L.push('OPEN / IN PROGRESS');
        open.forEach((t, i) => {
          L.push(`${i + 1}. ${t.title} [${t.context}] — by ${t.assignedBy} — ${URGENCY[t.urgency].short} — ${t.status === 'progress' ? 'in progress' : 'in inbox'}, ${fmtHM(elapsed(t))} so far${t.scope ? ' ⚠ CHANGE ORDER' : ''}`);
        });
      }
    }

    const rows = list.map((t) => [
      isoDate(t.closedAt || t.createdAt), t.title, t.assignedBy, hoursDec(elapsed(t)),
      t.scope ? 'Yes - change order' : 'No', t.resolution, t.context, URGENCY[t.urgency].label,
      t.status === 'done' ? 'Closed' : t.status === 'progress' ? 'In progress' : 'Inbox',
      new Date(t.createdAt).toISOString(), t.closedAt ? new Date(t.closedAt).toISOString() : ''
    ]);
    const csv = [CSV_HEAD, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
    return { text: L.join('\n'), csv, count: list.length };
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0;top:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      ta.remove();
      if (!ok) { toast('Copy failed — select the text and copy manually.', { kind: 'error' }); return; }
    }
    toast(okMsg, { kind: 'ok' });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename, style: 'display:none' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function refreshReport() {
    state.meta.reportRange = $('#r-range').value;
    $('#r-text').value = buildReport(state.meta.reportRange).text;
  }

  function openReport() {
    $('#r-range').value = state.meta.reportRange || 'week';
    $('#r-engineer').value = state.meta.engineer || '';
    $('#btn-share').hidden = !navigator.share;
    refreshReport();
    openDialog($('#dlg-report'));
  }

  /* =====================================================================
   * 11. Settings, backup & restore
   * ===================================================================== */
  async function refreshInfo() {
    let persisted = 'unknown', usage = '';
    try {
      if (navigator.storage && navigator.storage.persisted) persisted = (await navigator.storage.persisted()) ? 'granted' : 'not granted';
      if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); usage = ` · ${(e.usage / 1048576).toFixed(1)} MB used`; }
    } catch (_) { /* optional */ }
    const standalone = isStandalone() ? 'installed' : 'browser tab';
    $('#s-info').textContent = `${APP.name} v${APP.version} · Storage: ${Storage.mode === 'idb' ? 'IndexedDB' : 'localStorage (limited)'}${usage} · Persistent storage: ${persisted} · Offline cache: ${state.offlineReady ? 'ready' : 'not active'} · Mode: ${standalone}`;
  }

  function openSettings() {
    $('#s-engineer').value = state.meta.engineer || '';
    $('#s-theme').value = state.meta.theme;
    $('#s-contrast').checked = !!state.meta.contrast;
    $('#s-requesters').value = state.meta.requesters.join('\n');
    refreshInfo();
    openDialog($('#dlg-settings'));
  }

  function exportJson() {
    const payload = {
      app: 'adhoc-taskmanager', version: 1, exportedAt: new Date().toISOString(),
      meta: state.meta,
      tasks: [...state.tasks.values()].map((t) => ({ ...t, audio: null, hasAudio: !!t.audio }))
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `adhoc-taskmanager-backup_${isoDate(Date.now())}.json`);
    toast('Backup exported', { kind: 'ok' });
  }

  async function importJson(file) {
    if (!file) return;
    if (file.size > 10 * 1048576) { toast('That file is too large to be a backup (max 10 MB).', { kind: 'error' }); return; }
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.app !== 'adhoc-taskmanager' || !Array.isArray(data.tasks)) throw new Error('Not an AdHoc TaskManager backup');
      const incoming = data.tasks.map(sanitizeTask).filter(Boolean);
      const toWrite = [];
      for (const t of incoming) {
        const cur = state.tasks.get(t.id);
        if (!cur || t.updatedAt > cur.updatedAt) {
          if (cur && cur.audio && !t.audio) t.audio = cur.audio;
          state.tasks.set(t.id, t);
          toWrite.push(t);
        }
      }
      if (toWrite.length) await Storage.putMany(toWrite);
      if (data.meta && Array.isArray(data.meta.requesters)) {
        data.meta.requesters.map((r) => str(r, 80)).filter(Boolean).forEach((r) => {
          if (!state.meta.requesters.some((x) => x.toLowerCase() === r.toLowerCase())) state.meta.requesters.push(r);
        });
        saveMeta();
      }
      render();
      toast(`Imported ${toWrite.length} of ${incoming.length} tasks`, { kind: 'ok' });
    } catch (e) {
      console.error(e);
      toast(`Import failed: ${e.message || 'invalid file'}`, { kind: 'error' });
    }
  }

  async function clearAll() {
    if (!window.confirm('Erase ALL tasks on this device? This cannot be undone. Export a backup first if unsure.')) return;
    try { await Storage.clearTasks(); } catch (e) { console.error(e); }
    state.tasks.clear();
    render();
    closeDialog('#dlg-settings');
    toast('All tasks erased');
  }

  /* =====================================================================
   * 12. PWA: service worker, install flow, connectivity
   * ===================================================================== */
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferredPrompt = null;

  function updateInstallButton() {
    const btn = $('#btn-install');
    btn.hidden = isStandalone() || !(deferredPrompt || isIOS());
  }

  function bindInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      updateInstallButton();
    });
    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      updateInstallButton();
      toast('Installed — find AdHoc Tasks on your home screen.', { kind: 'ok' });
    });
    $('#btn-install').addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch (_) { /* ignore */ }
        deferredPrompt = null;
        updateInstallButton();
      } else if (isIOS()) {
        openDialog($('#dlg-ios'));
      }
    });
    updateInstallButton();
  }

  async function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (!secure) { console.info('[pwa] service worker needs HTTPS or localhost'); return; }
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return; // first install claims the page silently
      toast('A new version is ready.', { action: { label: 'Reload', fn: () => location.reload() }, timeout: 0 });
    });
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
      navigator.serviceWorker.ready.then(() => { state.offlineReady = true; });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    } catch (e) {
      console.warn('[pwa] service worker registration failed', e);
    }
  }

  let lastOnline = navigator.onLine;
  function updateNet(announceChange) {
    const on = navigator.onLine;
    const el = $('#net-status');
    el.dataset.online = String(on);
    el.textContent = on ? 'Online' : 'Offline';
    if (announceChange && on !== lastOnline) {
      toast(on ? 'Back online.' : 'You’re offline — everything still works and stays on this device.');
    }
    lastOnline = on;
  }

  /* =====================================================================
   * 13. Events & init
   * ===================================================================== */
  const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  function bindEvents() {
    // Navigation
    $$('.tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('#fab').addEventListener('click', () => openCapture());
    $('#btn-report').addEventListener('click', openReport);
    $('#btn-settings').addEventListener('click', openSettings);

    // Delegated task actions
    const delegate = (e) => {
      const b = e.target.closest('[data-action]');
      if (b) handleAction(b.dataset.action, b.dataset.id);
    };
    $('#list').addEventListener('click', delegate);
    $('#task-actions').addEventListener('click', delegate);

    // Search & filters
    $('#q').addEventListener('input', debounce((e) => { state.query = e.target.value; renderList(); }, 120));
    $('#f-group').addEventListener('change', (e) => { state.meta.group = e.target.value; saveMeta(); renderList(); });
    $('#f-context-filter').addEventListener('change', (e) => { state.ctx = e.target.value; renderList(); });
    $('#f-scope-only').addEventListener('change', (e) => { state.scopeOnly = e.target.checked; renderList(); });

    // Dialog plumbing
    document.addEventListener('click', (e) => {
      const c = e.target.closest('[data-close]');
      if (c) { closeDialog(c.closest('dialog')); return; }
      if (e.target instanceof HTMLDialogElement && e.target.open) closeDialog(e.target); // backdrop tap
    });
    $('#dlg-task').addEventListener('close', () => { state.detailId = null; revokeAudioUrl(); });
    $('#dlg-complete').addEventListener('close', () => { state.completeId = null; });
    $('#dlg-capture').addEventListener('close', () => {
      if (recorder) stopRecording(true);
      if (recognition && dictating) recognition.stop();
      const el = $('#f-audio');
      if (el.dataset.url) { URL.revokeObjectURL(el.dataset.url); delete el.dataset.url; }
      state.editingId = null;
    });

    // Capture form
    const form = $('#capture-form');
    form.addEventListener('submit', onCaptureSubmit);
    form.addEventListener('input', saveDraft);
    form.addEventListener('change', saveDraft);
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'f-requester-new') { e.preventDefault(); addRequester(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit($('#btn-save')); }
      else if (e.key === 'Enter' && e.target.id === 'f-title') { e.preventDefault(); form.requestSubmit($('#btn-save')); }
    });
    $('#btn-add-requester').addEventListener('click', addRequester);
    $('#btn-audio-clear').addEventListener('click', () => setAudio(null, true));
    if (window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      $('#btn-record').hidden = false;
      $('#btn-record').addEventListener('click', () => (recorder ? stopRecording(false) : startRecording()));
    }
    if (SpeechRec) {
      $('#btn-dictate').hidden = false;
      $('#btn-dictate').addEventListener('click', toggleDictation);
    }

    // Complete form
    $('#complete-form').addEventListener('submit', onCompleteSubmit);

    // Report
    $('#r-range').addEventListener('change', () => { refreshReport(); saveMeta(); });
    $('#r-engineer').addEventListener('input', debounce((e) => {
      state.meta.engineer = str(e.target.value, 80);
      saveMeta();
      refreshReport();
    }, 200));
    $('#btn-copy-summary').addEventListener('click', () => copyText(buildReport($('#r-range').value).text, 'Summary copied — paste it into WhatsApp, Email or ClickUp'));
    $('#btn-copy-csv').addEventListener('click', () => copyText(buildReport($('#r-range').value).csv, 'CSV copied'));
    $('#btn-csv').addEventListener('click', () => {
      const r = buildReport($('#r-range').value);
      downloadBlob(new Blob(['﻿', r.csv], { type: 'text/csv;charset=utf-8' }), `task28-adhoc-log_${isoDate(Date.now())}.csv`);
      toast(`CSV downloaded (${r.count} rows)`, { kind: 'ok' });
    });
    $('#btn-share').addEventListener('click', async () => {
      try { await navigator.share({ title: 'Task 28 ad-hoc work report', text: buildReport($('#r-range').value).text }); }
      catch (e) { if (e && e.name !== 'AbortError') toast('Sharing failed — use Copy summary instead.', { kind: 'error' }); }
    });

    // Settings
    $('#s-engineer').addEventListener('change', (e) => { state.meta.engineer = str(e.target.value, 80); saveMeta(); });
    $('#s-theme').addEventListener('change', (e) => { state.meta.theme = ['auto', 'dark', 'light'].includes(e.target.value) ? e.target.value : 'auto'; saveMeta(); applyTheme(); });
    $('#s-contrast').addEventListener('change', (e) => { state.meta.contrast = e.target.checked; saveMeta(); applyTheme(); });
    $('#s-requesters').addEventListener('change', (e) => {
      const list = [...new Set(e.target.value.split('\n').map((l) => str(l, 80)).filter(Boolean))].slice(0, 30);
      state.meta.requesters = list.length ? list : [...DEFAULT_REQUESTERS];
      e.target.value = state.meta.requesters.join('\n');
      saveMeta();
    });
    $('#btn-export-json').addEventListener('click', exportJson);
    $('#s-import').addEventListener('change', (e) => { importJson(e.target.files[0]); e.target.value = ''; });
    $('#btn-clear-all').addEventListener('click', clearAll);

    // Global
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || anyDialogOpen()) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openCapture(); }
      else if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
    });
    window.addEventListener('online', () => updateNet(true));
    window.addEventListener('offline', () => updateNet(true));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    mqDark.addEventListener && mqDark.addEventListener('change', applyTheme);
    mqContrast.addEventListener && mqContrast.addEventListener('change', applyTheme);
    window.matchMedia('(display-mode: standalone)').addEventListener && window.matchMedia('(display-mode: standalone)').addEventListener('change', updateInstallButton);
  }

  function mergeMeta(m) {
    if (!m || typeof m !== 'object') return;
    const reqs = Array.isArray(m.requesters) ? [...new Set(m.requesters.map((r) => str(r, 80)).filter(Boolean))].slice(0, 30) : null;
    if (reqs && reqs.length) state.meta.requesters = reqs;
    state.meta.engineer = str(m.engineer, 80);
    state.meta.theme = ['auto', 'dark', 'light'].includes(m.theme) ? m.theme : 'auto';
    state.meta.contrast = !!m.contrast;
    state.meta.group = m.group === 'requester' ? 'requester' : 'urgency';
    state.meta.lastRequester = str(m.lastRequester, 80);
    state.meta.lastContext = str(m.lastContext, 80);
    state.meta.reportRange = ['today', 'week', 'month', 'all'].includes(m.reportRange) ? m.reportRange : 'week';
  }

  function populateControls() {
    $('#f-context-filter').replaceChildren(h('option', { value: '' }, 'All contexts'), ...CONTEXTS.map((c) => h('option', { value: c }, c)));
    $('#f-group').value = state.meta.group;
  }

  function handleLaunchParams() {
    const p = new URLSearchParams(location.search);
    const view = p.get('view');
    if (view && hasOwn(VIEWS, view)) setView(view);
    const action = p.get('action');
    if (action === 'quick-add') openCapture();
    else if (action === 'report') openReport();
    if (p.has('action') || p.has('view')) {
      try { history.replaceState(null, '', location.pathname); } catch (_) { /* optional */ }
    }
  }

  async function init() {
    applyTheme();
    renderSkeleton();
    bindEvents();
    bindInstall();
    updateNet(false);
    registerSW();

    try {
      await Storage.init();
      mergeMeta(await Storage.getMeta());
      const rows = await Storage.allTasks();
      rows.map(sanitizeTask).filter(Boolean).forEach((t) => state.tasks.set(t.id, t));
    } catch (e) {
      console.error('[init] load failed', e);
      toast('Could not read saved tasks. Storage may be blocked in this browser mode.', { kind: 'error', timeout: 0 });
    }

    state.ready = true;
    applyTheme();
    populateControls();
    render();
    handleLaunchParams();
    setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
