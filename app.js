(() => {
  'use strict';

  /* ================= config & helpers ================= */
  const CFG = window.RR_CONFIG || {};
  const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email';
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(CFG.SHEET_ID || '');
  const TAB = { data: '_data', materials: 'Materials', todo: 'To Do', pics: 'PICs', updates: 'Updates' };
  const AUTH_KEY = 'rrAdminHub.auth';
  const CHUNK = 40000; // a Google Sheets cell holds at most 50,000 characters

  const STATUSES = ['Not Started', 'In Progress', 'Completed'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const PAGES = ['materials', 'todo', 'pics', 'updates'];
  const SHAPE = ['categories', 'todos', 'pics', 'updates', 'topics'];

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const todayISO = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const fmt = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return d + ' ' + MONTHS[m - 1] + ' ' + y;
  };
  const safeUrl = (u) => {
    u = String(u || '').trim();
    if (!u) return '#';
    return /^(https?:|mailto:)/i.test(u) ? u : 'https://' + u;
  };
  const linkify = (escaped) =>
    escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

  /* ================= state ================= */
  const EMPTY_SEED = { version: 1, managerName: 'Manager', topics: ['General'], categories: [], todos: [], pics: [], updates: [] };
  const seed = () => clone(window.SEED || EMPTY_SEED);
  const validShape = (d) => d && typeof d === 'object' && SHAPE.every((k) => Array.isArray(d[k]));

  // S is the working copy. The Google Sheet is the real store; nothing is kept in the browser.
  let S = clone(EMPTY_SEED);
  const app = { phase: 'gate', error: '', gsi: false }; // phase: config | gate | loading | denied | ready
  let auth = { token: '', exp: 0, email: '' };
  let syncRev = 0, dirty = false, pushing = false, pushTimer = null, lastSync = '';
  let syncState = 'checking', syncMsg = '';

  const ui = {
    page: 'materials',
    edit: false,
    search: '',
    todoTopic: 'All',
    todoStatus: 'open',
    editingTodo: null,
    editingUpdate: null,
  };

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /* ================= Google sign-in ================= */
  let tokenClient = null;
  let pendingAuth = null;
  const authErr = (m) => Object.assign(new Error(m), { auth: true });

  function whenGsi(cb) {
    if (window.google && google.accounts && google.accounts.oauth2) return cb();
    setTimeout(() => whenGsi(cb), 150);
  }

  function initAuth() {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) { pendingAuth && pendingAuth.reject(new Error(resp.error_description || resp.error)); return; }
        try {
          if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(resp, 'https://www.googleapis.com/auth/spreadsheets')) {
            pendingAuth && pendingAuth.reject(new Error('Please allow access to Google Sheets when Google asks.'));
            return;
          }
        } catch (e) { /* ignore */ }
        auth.token = resp.access_token;
        auth.exp = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
        try { sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth)); } catch (e) { /* ignore */ }
        pendingAuth && pendingAuth.resolve();
      },
      error_callback: (err) => { pendingAuth && pendingAuth.reject(new Error(err && err.type === 'popup_closed' ? 'The Google sign-in window was closed.' : 'Google sign-in failed.')); },
    });
    app.gsi = true;
  }

  function requestToken(prompt) {
    return new Promise((resolve, reject) => {
      pendingAuth = { resolve, reject };
      tokenClient.requestAccessToken({ prompt });
    });
  }

  function restoreToken() {
    try {
      const j = JSON.parse(sessionStorage.getItem(AUTH_KEY) || 'null');
      if (j && j.token && j.exp > Date.now() + 60000) { auth = j; return true; }
    } catch (e) { /* ignore */ }
    return false;
  }

  async function fetchEmail() {
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + auth.token } });
      if (r.ok) { auth.email = (await r.json()).email || ''; sessionStorage.setItem(AUTH_KEY, JSON.stringify(auth)); }
    } catch (e) { /* the email is only shown for information */ }
  }

  async function signIn(prompt) {
    if (!app.gsi) { toast('Google sign-in is still loading. Try again in a moment.'); return; }
    try {
      await requestToken(prompt || '');
      await fetchEmail();
      await startSession();
    } catch (e) {
      app.phase = 'gate'; app.error = e.message; render();
    }
  }

  function signOut() {
    if (dirty && !confirm('You have changes that are not saved to Google yet. Sign out anyway?')) return;
    try { if (auth.token && google.accounts.oauth2.revoke) google.accounts.oauth2.revoke(auth.token, () => {}); } catch (e) { /* ignore */ }
    auth = { token: '', exp: 0, email: '' };
    try { sessionStorage.removeItem(AUTH_KEY); } catch (e) { /* ignore */ }
    S = clone(EMPTY_SEED); dirty = false; syncRev = 0;
    clearTimeout(pushTimer);
    const d = $('#dlg'); if (d.open) d.close();
    app.phase = 'gate'; app.error = ''; render();
  }

  /* ================= Google Sheets storage ================= */
  const range = (tab, a1) => encodeURIComponent("'" + tab + "'!" + a1);

  async function gapi(path, opts) {
    if (auth.exp < Date.now() + 15000) throw authErr('Your Google session expired. Sign in again to keep saving.');
    let res;
    try {
      res = await fetch(SHEETS + path, Object.assign({ headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' } }, opts || {}));
    } catch (e) {
      throw new Error('Could not reach Google. Check your connection; your changes are kept on this page until they save.');
    }
    if (res.status === 401) throw authErr('Your Google session expired. Sign in again to keep saving.');
    let j = {};
    try { j = await res.json(); } catch (e) { /* empty body */ }
    if (res.status === 403) throw new Error('This Google account does not have edit access to the sheet. Ask the sheet owner to share it with you as an Editor.');
    if (res.status === 404) throw new Error('Google Sheet not found. Check SHEET_ID in config.js.');
    if (!res.ok) throw new Error((j.error && j.error.message) || 'Google returned an error (' + res.status + ').');
    return j;
  }

  async function ensureSheets() {
    const meta = await gapi('?fields=sheets.properties(sheetId,title)');
    const have = new Set((meta.sheets || []).map((s) => s.properties.title));
    const add = Object.values(TAB).filter((t) => !have.has(t));
    if (!add.length) return;
    const r = await gapi(':batchUpdate', { method: 'POST', body: JSON.stringify({
      requests: add.map((t) => ({ addSheet: { properties: { title: t, hidden: t === TAB.data } } })) }) });
    const fmtReqs = [];
    (r.replies || []).forEach((rep) => {
      const p = rep.addSheet && rep.addSheet.properties;
      if (!p || p.title === TAB.data) return;
      fmtReqs.push({ repeatCell: { range: { sheetId: p.sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.067, green: 0.2, blue: 0.4 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat)' } });
      fmtReqs.push({ updateSheetProperties: { properties: { sheetId: p.sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    });
    if (fmtReqs.length) await gapi(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: fmtReqs }) });
  }

  // _data layout: A1 = revision, A2 = number of chunks, A3 = saved time, A4 downwards = the data as JSON text.
  async function readRev() {
    const j = await gapi('/values/' + range(TAB.data, 'A1') + '?valueRenderOption=UNFORMATTED_VALUE');
    return (j.values && j.values[0] && Number(j.values[0][0])) || 0;
  }

  async function loadRemote() {
    const j = await gapi('/values/' + range(TAB.data, 'A1:A') + '?valueRenderOption=UNFORMATTED_VALUE');
    const v = j.values || [];
    const cell = (i) => (v[i] && v[i][0] != null ? v[i][0] : '');
    const rev = Number(cell(0)) || 0;
    const count = Number(cell(1)) || 0;
    let json = '';
    for (let i = 0; i < count; i++) json += String(cell(3 + i));
    return { rev, data: json ? JSON.parse(json) : null };
  }

  async function writeRemote(data, rev) {
    const json = JSON.stringify(data);
    const chunks = [];
    for (let i = 0; i < json.length; i += CHUNK) chunks.push([json.substr(i, CHUNK)]);
    const values = [[rev], [chunks.length], [new Date().toISOString()]].concat(chunks);
    await gapi('/values/' + range(TAB.data, 'A1:A' + values.length) + '?valueInputOption=RAW', { method: 'PUT', body: JSON.stringify({ values }) });
    // tidy up leftover rows from an older, longer save (the chunk count in A2 already ignores them)
    try { await gapi('/values:batchClear', { method: 'POST', body: JSON.stringify({ ranges: [decodeURIComponent(range(TAB.data, 'A' + (values.length + 1) + ':A'))] }) }); } catch (e) { /* harmless */ }
    try { await writeMirrors(data); } catch (e) { if (e.auth) throw e; /* mirrors are only for viewing */ }
  }

  async function writeMirrors(d) {
    const mat = [];
    d.categories.forEach((c) => c.items.forEach((it) => {
      if (!it.links.length) mat.push([c.name, it.name, '', '', it.note || '']);
      it.links.forEach((l, i) => mat.push([c.name, it.name, l.label, l.url, i === 0 ? (it.note || '') : '']));
    }));
    const pics = [];
    d.pics.forEach((p) => p.contacts.forEach((c) => pics.push([p.project, c.role, c.name, c.email])));
    const tabs = [
      [TAB.materials, ['Category', 'Item', 'Button Label', 'URL', 'Notes'], mat],
      [TAB.todo, ['Date Added', 'Topic', 'Task', 'Due Date', 'Status', 'Comments'], d.todos.map((t) => [t.date, t.topic, t.task, t.due, t.status, t.comments])],
      [TAB.pics, ['Project', 'Market / Role', 'Name', 'Email'], pics],
      [TAB.updates, ['Date', 'Topic', 'Key Updates', 'Comments'], d.updates.map((u) => [u.date, u.topic, u.update, u.comments])],
    ];
    const str = (row) => row.map((x) => (x == null ? '' : String(x)));
    await gapi('/values:batchClear', { method: 'POST', body: JSON.stringify({ ranges: tabs.map((t) => "'" + t[0] + "'!A:Z") }) });
    await gapi('/values:batchUpdate', { method: 'POST', body: JSON.stringify({
      valueInputOption: 'RAW',
      data: tabs.map((t) => ({ range: "'" + t[0] + "'!A1", values: [t[1]].concat(t[2].map(str)) })) }) });
  }

  /* ================= sync engine ================= */
  const SYNC_LABELS = { checking: 'Checking…', saving: 'Saving…', synced: 'Synced', error: 'Not Synced (Retry)', signin: 'Sign In To Save', conflict: 'Resolve Conflict' };

  function setStatus(state, msg) {
    syncState = state; syncMsg = msg || '';
    const b = $('#syncStatus');
    if (b) { b.innerHTML = `<span class="dot dot-${state}"></span>${SYNC_LABELS[state] || ''}`; b.title = syncMsg; }
    const line = $('#syncLine');
    if (line) line.textContent = `${SYNC_LABELS[state]}. Last synced: ${lastSync ? new Date(lastSync).toLocaleString() : 'not yet'}.${syncMsg ? ' ' + syncMsg : ''}`;
  }

  function markSynced() { lastSync = new Date().toISOString(); setStatus('synced'); }
  function syncFailed(e) { setStatus(e.auth ? 'signin' : 'error', e.message); }

  // Every edit calls save(): it queues an upload to the Google Sheet.
  function save() {
    dirty = true;
    schedulePush();
  }

  function schedulePush() {
    if (syncState === 'conflict') return;
    setStatus('saving');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push(false), 1200);
  }

  async function push(force) {
    if (app.phase !== 'ready') return;
    if (pushing) { clearTimeout(pushTimer); pushTimer = setTimeout(() => push(force), 700); return; }
    pushing = true;
    setStatus('saving');
    try {
      const snapshot = JSON.stringify(S);
      const cur = await readRev();
      if (!force && cur !== syncRev) { openConflict(); return; }
      const next = cur + 1;
      await writeRemote(S, next);
      syncRev = next;
      dirty = JSON.stringify(S) !== snapshot; // edited again while uploading
      if (dirty) schedulePush(); else markSynced();
    } catch (e) {
      syncFailed(e);
    } finally {
      pushing = false;
    }
  }

  async function pull() {
    if (app.phase !== 'ready') return;
    setStatus('checking');
    try {
      const cur = await readRev();
      if (cur === syncRev) { if (dirty) await push(false); else markSynced(); return; }
      if (dirty) { openConflict(); return; }
      const r = await loadRemote();
      adopt(r.data, r.rev);
    } catch (e) { syncFailed(e); }
  }

  function adopt(data, rev) {
    if (!validShape(data)) throw new Error('The data in the sheet looks damaged.');
    S = data;
    if (!S.managerName) S.managerName = 'Manager';
    syncRev = rev; dirty = false;
    markSynced();
    render();
  }

  async function startSession() {
    app.phase = 'loading'; app.error = ''; render();
    try {
      await ensureSheets();
      const r = await loadRemote();
      if (r.data === null) {
        // First time: move the starting data (data.js) into the Google Sheet.
        S = seed(); syncRev = 0; dirty = true;
        app.phase = 'ready'; render();
        await push(true);
        if (syncState === 'synced') toast('Your starting data is now saved in the Google Sheet. You can delete data.js from your site.');
      } else {
        adopt(r.data, r.rev);
        app.phase = 'ready'; render();
      }
    } catch (e) {
      app.phase = e.auth ? 'gate' : 'denied';
      app.error = e.message;
      render();
    }
  }

  function openConflict() {
    setStatus('conflict', 'The Google Sheet has a different version than this page.');
    let d = $('#dlgConflict');
    if (!d) { d = document.createElement('dialog'); d.id = 'dlgConflict'; document.body.appendChild(d); }
    d.innerHTML = `<div class="dlg-in">
      <h2>Which Version Do You Want To Keep?</h2>
      <p class="hint" style="margin:8px 0 14px">The Google Sheet was changed since this page loaded, for example from another device. You can keep only one version.</p>
      <div class="btn-row" style="flex-direction:column;align-items:stretch">
        <button class="btn btn-primary" type="button" data-action="conflict-sheet">Use The Google Sheet Version</button>
        <button class="btn" type="button" data-action="conflict-local">Keep This Page's Version And Overwrite The Sheet</button>
        <button class="btn-quiet" type="button" data-action="export">Download This Page's Data First</button>
      </div></div>`;
    if (!d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); }
  }
  function closeConflict() { const d = $('#dlgConflict'); if (d && d.open) d.close(); }

  async function resolveWithSheet() {
    closeConflict();
    setStatus('checking');
    try { const r = await loadRemote(); adopt(r.data, r.rev); toast('Loaded the Google Sheet version'); }
    catch (e) { syncFailed(e); }
  }

  /* ================= shared pieces ================= */
  function topicOptions(selected, forFilter) {
    let h = forFilter ? `<option value="All"${selected === 'All' ? ' selected' : ''}>All Topics</option>` : '';
    S.topics.forEach((t) => { h += `<option value="${esc(t)}"${t === selected ? ' selected' : ''}>${esc(t)}</option>`; });
    if (!forFilter) h += '<option value="__new">Add New "Topic"…</option>';
    return h;
  }
  const topicSelect = (id, selected) =>
    `<select id="${id}" data-topic-select>${topicOptions(selected || S.topics[0], false)}</select>`;

  function refreshTopicSelects() {
    $$('select[data-topic-select]').forEach((sel) => {
      const cur = sel.value === '__new' ? S.topics[0] : sel.value;
      sel.innerHTML = topicOptions(cur, false);
      sel.value = S.topics.includes(cur) ? cur : S.topics[0];
    });
    $$('select[data-topic-filter]').forEach((sel) => { sel.innerHTML = topicOptions(ui.todoTopic, true); });
  }

  /* ================= routing & shell ================= */
  function route() {
    const p = location.hash.slice(1);
    ui.page = PAGES.includes(p) ? p : 'materials';
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    document.body.classList.toggle('locked', app.phase !== 'ready');
    $$('#nav a').forEach((a) => {
      if (a.dataset.page === ui.page) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const v = $('#view');
    if (app.phase !== 'ready') { v.innerHTML = gateView(); return; }
    if (ui.page === 'materials') { v.innerHTML = materialsView(); renderMatList(); }
    else if (ui.page === 'todo') { v.innerHTML = todoView(); renderTodoList(); fillTodoForm(); }
    else if (ui.page === 'pics') { v.innerHTML = picsView(); }
    else { v.innerHTML = updatesView(); renderUpdateList(); fillUpdateForm(); }
    setStatus(syncState, syncMsg);
  }

  function gateView() {
    let body;
    if (app.phase === 'config') {
      body = `<h1>Setup Needed</h1>
        <p>Open <b>config.js</b> and fill in your Google <b>CLIENT_ID</b> and <b>SHEET_ID</b>, then upload it again. Steps are in <b>SETUP.md</b>.</p>`;
    } else if (app.phase === 'loading') {
      body = `<h1>Loading Your Data…</h1><p>Reading from your Google Sheet.</p>`;
    } else if (app.phase === 'denied') {
      body = `<h1>Could Not Open The Sheet</h1><p>${esc(app.error)}</p>
        <div class="form-actions"><button class="btn btn-primary" type="button" data-action="sign-in-other">Sign In With A Different Account</button><button class="btn" type="button" data-action="sign-in">Try Again</button></div>`;
    } else {
      body = `<h1>RR Admin Hub</h1>
        <p>Sign in with your Google account to open your data.</p>
        <div class="form-actions"><button class="btn btn-primary" type="button" data-action="sign-in" ${app.gsi ? '' : 'disabled'}>${app.gsi ? 'Sign In With Google' : 'Loading Google…'}</button></div>
        ${app.error ? `<p class="gate-error">${esc(app.error)}</p>` : ''}`;
    }
    return `<section class="card gate">${body}</section>`;
  }

  /* ================= 1. materials ================= */
  function materialsView() {
    return `
      <div class="page-head">
        <h1>Materials</h1>
        <div class="tools">
          <input id="matSearch" type="search" placeholder="Search Links" aria-label="Search materials" value="${esc(ui.search)}">
          <button class="btn ${ui.edit ? 'btn-primary' : ''}" type="button" data-action="toggle-edit" aria-pressed="${ui.edit}">${ui.edit ? 'Done Editing' : 'Edit Links'}</button>
        </div>
      </div>
      <div class="mat-layout">
        <nav class="rail" id="matRail" aria-label="Categories"></nav>
        <div id="matList"></div>
      </div>`;
  }

  function itemMatches(item, q) {
    if (!q) return true;
    const hay = (item.name + ' ' + (item.note || '') + ' ' + item.links.map((l) => l.label).join(' ')).toLowerCase();
    return hay.includes(q);
  }

  function renderRail() {
    $('#matRail').innerHTML = S.categories.map((c, ci) => `<a href="#cat-${ci}" data-jump="cat-${ci}">${esc(c.name)}</a>`).join('');
  }

  function renderMatList() {
    const q = ui.search.trim().toLowerCase();
    renderRail();
    let html = '';
    S.categories.forEach((c, ci) => {
      const items = c.items.map((it, ii) => ({ it, ii })).filter(({ it }) => ui.edit || itemMatches(it, q));
      if (!ui.edit && q && !items.length) return;
      const head = ui.edit
        ? `<div class="cat-head"><input data-f="cat-name" data-ci="${ci}" value="${esc(c.name)}" aria-label="Category name"><button class="btn-quiet" type="button" data-action="del-cat" data-ci="${ci}">Delete Category</button></div>`
        : `<div class="cat-head"><h2>${esc(c.name)}</h2><span class="count">${items.length} ${items.length === 1 ? 'Item' : 'Items'}</span></div>`;
      const body = items.map(({ it, ii }) => (ui.edit ? itemEdit(it, ci, ii) : itemView(it))).join('');
      const add = ui.edit ? `<div class="add-line"><button class="btn-quiet" type="button" data-action="add-item" data-ci="${ci}">Add "Item"</button></div>` : '';
      html += `<section class="cat" id="cat-${ci}">${head}<div class="cat-body">${body || '<div class="item"><span class="hint">No items yet.</span></div>'}${add}</div></section>`;
    });
    if (ui.edit) html += `<button class="btn add-cat" type="button" data-action="add-cat">Add "Category"</button>`;
    if (!html) html = `<div class="empty">Nothing matches “${esc(ui.search)}”.</div>`;
    $('#matList').innerHTML = html;
  }

  function itemView(it) {
    const links = it.links
      .map((l) => `<a class="lbtn" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.label || l.url)}</a>`)
      .join('');
    return `<div class="item"><div class="item-name">${esc(it.name)}</div><div class="item-links">${links || '<span class="hint">No links yet. Use Edit Links to add one.</span>'}</div>${it.note ? `<p class="item-note">${esc(it.note)}</p>` : ''}</div>`;
  }

  function itemEdit(it, ci, ii) {
    const links = it.links
      .map((l, li) => `<div class="link-edit">
          <input data-f="link-label" data-ci="${ci}" data-ii="${ii}" data-li="${li}" value="${esc(l.label)}" placeholder="Button Label" aria-label="Button label">
          <input data-f="link-url" data-ci="${ci}" data-ii="${ii}" data-li="${li}" value="${esc(l.url)}" placeholder="https://" aria-label="Link URL">
          <button class="btn-quiet danger" type="button" data-action="del-link" data-ci="${ci}" data-ii="${ii}" data-li="${li}" aria-label="Remove link">Remove</button>
        </div>`).join('');
    return `<div class="item editing">
      <div class="edit-row"><input data-f="item-name" data-ci="${ci}" data-ii="${ii}" value="${esc(it.name)}" aria-label="Item name"><button class="btn-quiet danger" type="button" data-action="del-item" data-ci="${ci}" data-ii="${ii}">Delete Item</button></div>
      <div>${links}</div>
      <div><button class="btn-quiet" type="button" data-action="add-link" data-ci="${ci}" data-ii="${ii}">Add "Link"</button></div>
      <textarea data-f="item-note" data-ci="${ci}" data-ii="${ii}" rows="2" placeholder="Notes (Optional)" aria-label="Notes">${esc(it.note || '')}</textarea>
    </div>`;
  }

  /* ================= 2. To Do ================= */
  function todoView() {
    return `
      <div class="page-head"><h1>To Do</h1></div>
      <section class="card" aria-labelledby="todoFormTitle">
        <h2 id="todoFormTitle">New "To Do"</h2>
        <div id="todoEditing" class="editing-banner" hidden>You are editing an existing "To Do".</div>
        <div class="form-grid">
          <label>Topic ${topicSelect('todoTopic', S.topics[0])}</label>
          <label>Due Date <input type="date" id="todoDue"></label>
          <label>Status <select id="todoStatus">${STATUSES.map((s) => `<option>${s}</option>`).join('')}</select></label>
          <label class="span3">Task <textarea id="todoTask" rows="2" placeholder="What needs to be done?"></textarea></label>
          <label class="span3">Comments <textarea id="todoComments" rows="2" placeholder="Optional notes or links"></textarea></label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" type="button" id="todoSaveBtn" data-action="todo-save">Add "To Do"</button>
          <button class="btn" type="button" id="todoCancelBtn" data-action="todo-cancel" hidden>Cancel</button>
        </div>
      </section>
      <div class="filters">
        <label>Show Topic <select data-topic-filter id="todoTopicFilter">${topicOptions(ui.todoTopic, true)}</select></label>
        <div class="seg" role="group" aria-label="Filter by status">
          <button type="button" data-action="todo-filter" data-v="open" aria-pressed="${ui.todoStatus === 'open'}">Open</button>
          <button type="button" data-action="todo-filter" data-v="done" aria-pressed="${ui.todoStatus === 'done'}">Completed</button>
          <button type="button" data-action="todo-filter" data-v="all" aria-pressed="${ui.todoStatus === 'all'}">All</button>
        </div>
      </div>
      <div id="todoList"></div>`;
  }

  const statusRank = { 'In Progress': 0, 'Not Started': 1, 'Completed': 2 };

  function renderTodoList() {
    const rows = S.todos.filter((t) => {
      if (ui.todoTopic !== 'All' && t.topic !== ui.todoTopic) return false;
      if (ui.todoStatus === 'open') return t.status !== 'Completed';
      if (ui.todoStatus === 'done') return t.status === 'Completed';
      return true;
    });
    if (!rows.length) {
      $('#todoList').innerHTML = `<div class="empty">${S.todos.length ? 'No "To Do" items match this filter.' : 'No "To Do" items yet. Add your first one above.'}</div>`;
      return;
    }
    const topics = S.topics.concat([...new Set(rows.map((r) => r.topic))].filter((t) => !S.topics.includes(t)));
    const today = todayISO();
    let html = '';
    topics.forEach((topic) => {
      const g = rows.filter((r) => r.topic === topic).sort((a, b) =>
        (statusRank[a.status] - statusRank[b.status]) || ((a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : 0) || ((b.date || '') < (a.date || '') ? -1 : 1));
      if (!g.length) return;
      const open = g.filter((r) => r.status !== 'Completed').length;
      html += `<section class="group"><div class="group-head"><h2>${esc(topic)}</h2><span class="sub">${open} open, ${g.length - open} completed</span></div>`;
      g.forEach((t) => {
        const overdue = t.due && t.due < today && t.status !== 'Completed';
        html += `<article class="todo s-${slug(t.status)}">
          <div>
            <p class="todo-task">${linkify(esc(t.task))}</p>
            <p class="todo-meta">${t.date ? `<span>Added ${fmt(t.date)}</span>` : ''}${t.due ? `<span class="${overdue ? 'overdue' : ''}">Due ${fmt(t.due)}${overdue ? ' (overdue)' : ''}</span>` : ''}</p>
            ${t.comments ? `<p class="todo-comments">${linkify(esc(t.comments))}</p>` : ''}
          </div>
          <div class="todo-side">
            <select class="status st-${slug(t.status)}" data-f="todo-status" data-id="${t.id}" aria-label="Status">${STATUSES.map((s) => `<option${s === t.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
            <div class="row"><button class="btn-quiet" type="button" data-action="todo-edit" data-id="${t.id}">Edit</button><button class="btn-quiet danger" type="button" data-action="todo-del" data-id="${t.id}">Delete</button></div>
          </div>
        </article>`;
      });
      html += '</section>';
    });
    $('#todoList').innerHTML = html;
  }

  function fillTodoForm() {
    const t = S.todos.find((x) => x.id === ui.editingTodo);
    if (!t) { ui.editingTodo = null; return; }
    $('#todoTopic').value = t.topic;
    $('#todoDue').value = t.due || '';
    $('#todoStatus').value = t.status;
    $('#todoTask').value = t.task;
    $('#todoComments').value = t.comments || '';
    $('#todoSaveBtn').textContent = 'Save Changes';
    $('#todoCancelBtn').hidden = false;
    $('#todoEditing').hidden = false;
  }

  function resetTodoForm() {
    ui.editingTodo = null;
    $('#todoDue').value = '';
    $('#todoStatus').value = 'Not Started';
    $('#todoTask').value = '';
    $('#todoComments').value = '';
    $('#todoSaveBtn').textContent = 'Add "To Do"';
    $('#todoCancelBtn').hidden = true;
    $('#todoEditing').hidden = true;
  }

  /* ================= 3. Project PICs ================= */
  function picsView() {
    const cards = S.pics.map((p, pi) => `
      <section class="card" aria-label="${esc(p.project)}">
        <div class="pic-head">
          <input class="pic-title" data-f="pic-project" data-pi="${pi}" value="${esc(p.project)}" aria-label="Project name">
          <button class="btn-quiet danger" type="button" data-action="del-pic" data-pi="${pi}">Delete Project</button>
        </div>
        <div class="crow hd"><span>Market / Role</span><span>Name</span><span>Email</span><span></span><span></span></div>
        ${p.contacts.map((c, k) => `
          <div class="crow">
            <input data-f="pic-role" data-pi="${pi}" data-k="${k}" value="${esc(c.role)}" aria-label="Market or role">
            <input data-f="pic-name" data-pi="${pi}" data-k="${k}" value="${esc(c.name)}" aria-label="Name">
            <input data-f="pic-email" data-pi="${pi}" data-k="${k}" value="${esc(c.email)}" type="email" aria-label="Email">
            <a class="mail" href="mailto:${esc(c.email)}">Email</a>
            <button class="btn-quiet danger" type="button" data-action="del-contact" data-pi="${pi}" data-k="${k}" aria-label="Remove contact">Remove</button>
          </div>`).join('')}
        <div style="margin-top:8px"><button class="btn-quiet" type="button" data-action="add-contact" data-pi="${pi}">Add "Contact"</button></div>
      </section>`).join('');
    return `
      <div class="page-head">
        <h1>Project PICs</h1>
        <button class="btn" type="button" data-action="add-pic">Add "Project"</button>
      </div>
      <div class="pic-grid">${cards || '<div class="empty">No projects yet.</div>'}</div>`;
  }

  /* ================= 4. Manager Updates ================= */
  function updatesView() {
    return `
      <div class="page-head"><h1>Updates To ${esc(S.managerName)}</h1></div>
      <section class="card" aria-labelledby="updFormTitle">
        <h2 id="updFormTitle">New "Update"</h2>
        <div id="updEditing" class="editing-banner" hidden>You are editing an existing "Update".</div>
        <div class="form-grid">
          <label>Date <input type="date" id="updDate" value="${todayISO()}"></label>
          <label>Topic ${topicSelect('updTopic', S.topics[0])}</label>
          <span></span>
          <label class="span3">Key Updates <textarea id="updText" rows="4" placeholder="What should ${esc(S.managerName)} know?"></textarea></label>
          <label class="span3">Comments Or Questions <textarea id="updComments" rows="2" placeholder="Optional: questions to ask, or the response you got"></textarea></label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" type="button" id="updSaveBtn" data-action="upd-save">Add "Update"</button>
          <button class="btn" type="button" id="updCancelBtn" data-action="upd-cancel" hidden>Cancel</button>
        </div>
      </section>
      <div id="updList"></div>`;
  }

  function renderUpdateList() {
    if (!S.updates.length) { $('#updList').innerHTML = '<div class="empty" style="margin-top:22px">No "Update" items yet. Add your first one above.</div>'; return; }
    const dates = [...new Set(S.updates.map((u) => u.date || ''))].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    $('#updList').innerHTML = dates.map((d) => {
      const g = S.updates.filter((u) => (u.date || '') === d);
      return `<section class="date-group">
        <div class="date-head"><h2>${d ? fmt(d) : 'No Date'}</h2><button class="btn" type="button" data-action="upd-copy" data-date="${esc(d)}">Copy As Text</button></div>
        ${g.map((u) => `<article class="upd">
          <div class="upd-top"><span class="tag">${esc(u.topic)}</span><span><button class="btn-quiet" type="button" data-action="upd-edit" data-id="${u.id}">Edit</button><button class="btn-quiet danger" type="button" data-action="upd-del" data-id="${u.id}">Delete</button></span></div>
          <p class="upd-body">${linkify(esc(u.update))}</p>
          ${u.comments ? `<p class="upd-comments"><b>Comments:</b> ${linkify(esc(u.comments))}</p>` : ''}
        </article>`).join('')}
      </section>`;
    }).join('');
  }

  function fillUpdateForm() {
    const u = S.updates.find((x) => x.id === ui.editingUpdate);
    if (!u) { ui.editingUpdate = null; return; }
    $('#updDate').value = u.date || '';
    $('#updTopic').value = u.topic;
    $('#updText').value = u.update;
    $('#updComments').value = u.comments || '';
    $('#updSaveBtn').textContent = 'Save Changes';
    $('#updCancelBtn').hidden = false;
    $('#updEditing').hidden = false;
  }

  function resetUpdateForm() {
    ui.editingUpdate = null;
    $('#updDate').value = todayISO();
    $('#updText').value = '';
    $('#updComments').value = '';
    $('#updSaveBtn').textContent = 'Add "Update"';
    $('#updCancelBtn').hidden = true;
    $('#updEditing').hidden = true;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise((res, rej) => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? res() : rej(); } catch (e) { rej(e); } finally { ta.remove(); }
    });
  }

  /* ================= settings dialog ================= */
  const topicUse = (t) => S.todos.filter((x) => x.topic === t).length + S.updates.filter((x) => x.topic === t).length;

  function renderSettings() {
    $('#dlg').innerHTML = `<div class="dlg-in">
      <div class="dlg-top"><h2 id="dlgTitle">Settings &amp; Backup</h2><button class="btn-quiet" type="button" data-action="close-dlg">Close</button></div>

      <h3>Account &amp; Sync</h3>
      <p class="hint">Signed in as <b>${esc(auth.email || 'your Google account')}</b>. Your data is saved in the Google Sheet, so it follows you across devices.</p>
      <p class="hint" id="syncLine" style="margin-top:6px"></p>
      <div class="btn-row"><button class="btn" type="button" data-action="sync-now">Sync Now</button><button class="btn" type="button" data-action="sign-out">Sign Out</button></div>
      ${window.SEED ? `<p class="hint" style="margin-top:10px">Your starting data is already in the sheet. You can delete <b>data.js</b> from your site files, because it is no longer used.</p>` : ''}

      <h3>Reporting Manager</h3>
      <label>Name shown on the updates page <input data-f="manager" value="${esc(S.managerName)}"></label>

      <h3>Topics</h3>
      <p class="hint">Used by both the "To Do" and "Update" pages. Renaming a topic updates every entry using it.</p>
      <div style="margin-top:8px">${S.topics.map((t, i) => {
        const n = topicUse(t);
        return `<div class="topic-row">
          <input data-f="topic-rename" data-i="${i}" value="${esc(t)}" aria-label="Topic name">
          <button class="btn-quiet danger" type="button" data-action="del-topic" data-i="${i}" ${n ? 'disabled' : ''} title="${n ? 'In use by ' + n + ' entries' : 'Delete topic'}">Delete</button>
        </div>`; }).join('')}</div>
      <div class="topic-add"><input id="newTopic" placeholder="New topic name" aria-label="New topic name"><button class="btn" type="button" data-action="add-topic">Add "Topic"</button></div>

      <h3>Backup</h3>
      <p class="hint">A backup file is a second copy that does not depend on Google.${S.lastExport ? ' Last backup: ' + fmt(S.lastExport) + '.' : ' No backup downloaded yet.'}</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-action="export">Download Backup</button>
        <button class="btn" type="button" data-action="import">Restore From Backup</button>
      </div>
    </div>`;
  }

  function openSettings() {
    renderSettings();
    setStatus(syncState, syncMsg);
    const d = $('#dlg');
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }

  function exportData() {
    S.lastExport = todayISO();
    save();
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rr-admin-hub-backup-' + todayISO() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    if ($('#dlg').open) renderSettings();
    setStatus(syncState, syncMsg);
    toast('Backup downloaded');
  }

  /* ================= actions (clicks) ================= */
  const A = {
    'sign-in'() { signIn(''); },
    'sign-in-other'() { signIn('select_account'); },
    'sign-out'() { signOut(); },
    'sync-now'() { if (syncState === 'signin') reauth(); else (dirty ? push(false) : pull()); },
    'conflict-sheet'() { resolveWithSheet(); },
    'conflict-local'() { closeConflict(); push(true); },

    'toggle-edit'() { ui.edit = !ui.edit; render(); },
    'add-cat'() { S.categories.push({ name: 'New Category', items: [] }); save(); renderMatList(); const i = S.categories.length - 1; const el = $(`[data-f="cat-name"][data-ci="${i}"]`); if (el) { el.focus(); el.select(); } },
    'del-cat'(d) { const c = S.categories[d.ci]; if (confirm(`Delete the category "${c.name}" and its ${c.items.length} items?`)) { S.categories.splice(d.ci, 1); save(); renderMatList(); } },
    'add-item'(d) { S.categories[d.ci].items.push({ id: uid(), name: 'New Item', note: '', links: [{ label: 'Open Link', url: '' }] }); save(); renderMatList(); const i = S.categories[d.ci].items.length - 1; const el = $(`[data-f="item-name"][data-ci="${d.ci}"][data-ii="${i}"]`); if (el) { el.focus(); el.select(); } },
    'del-item'(d) { const it = S.categories[d.ci].items[d.ii]; if (confirm(`Delete "${it.name}"?`)) { S.categories[d.ci].items.splice(d.ii, 1); save(); renderMatList(); } },
    'add-link'(d) { const it = S.categories[d.ci].items[d.ii]; it.links.push({ label: '', url: '' }); save(); renderMatList(); const el = $(`[data-f="link-label"][data-ci="${d.ci}"][data-ii="${d.ii}"][data-li="${it.links.length - 1}"]`); if (el) el.focus(); },
    'del-link'(d) { S.categories[d.ci].items[d.ii].links.splice(d.li, 1); save(); renderMatList(); },

    'todo-filter'(d) { ui.todoStatus = d.v; $$('[data-action="todo-filter"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === d.v))); renderTodoList(); },
    'todo-save'() {
      const task = $('#todoTask').value.trim();
      if (!task) { toast('Write the task first'); $('#todoTask').focus(); return; }
      const rec = { topic: $('#todoTopic').value, task, due: $('#todoDue').value, status: $('#todoStatus').value, comments: $('#todoComments').value.trim() };
      if (ui.editingTodo) {
        Object.assign(S.todos.find((x) => x.id === ui.editingTodo), rec);
        toast('Changes saved');
      } else {
        S.todos.unshift(Object.assign({ id: uid(), date: todayISO() }, rec));
        toast('"To Do" added');
      }
      save(); resetTodoForm();
      if (ui.todoTopic !== 'All' && ui.todoTopic !== rec.topic) ui.todoTopic = 'All';
      $('#todoTopicFilter').value = ui.todoTopic;
      if (ui.todoStatus === 'done' && rec.status !== 'Completed') { ui.todoStatus = 'open'; $$('[data-action="todo-filter"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === 'open'))); }
      renderTodoList();
    },
    'todo-cancel'() { resetTodoForm(); },
    'todo-edit'(d) { ui.editingTodo = d.id; fillTodoForm(); $('#todoTask').focus(); $('#todoFormTitle').scrollIntoView({ block: 'center' }); },
    'todo-del'(d) { if (confirm('Delete this "To Do"?')) { S.todos = S.todos.filter((x) => x.id !== d.id); if (ui.editingTodo === d.id) resetTodoForm(); save(); renderTodoList(); } },

    'add-pic'() { S.pics.push({ id: uid(), project: 'New Project', contacts: [{ id: uid(), role: '', name: '', email: '' }] }); save(); $('#view').innerHTML = picsView(); const els = $$('[data-f="pic-project"]'); const el = els[els.length - 1]; if (el) { el.focus(); el.select(); } },
    'del-pic'(d) { const p = S.pics[d.pi]; if (confirm(`Delete the project "${p.project}" and its ${p.contacts.length} contacts?`)) { S.pics.splice(d.pi, 1); save(); $('#view').innerHTML = picsView(); } },
    'add-contact'(d) { S.pics[d.pi].contacts.push({ id: uid(), role: '', name: '', email: '' }); save(); $('#view').innerHTML = picsView(); const els = $$(`[data-f="pic-role"][data-pi="${d.pi}"]`); const el = els[els.length - 1]; if (el) el.focus(); },
    'del-contact'(d) { S.pics[d.pi].contacts.splice(d.k, 1); save(); $('#view').innerHTML = picsView(); },

    'upd-save'() {
      const text = $('#updText').value.trim();
      if (!text) { toast('Write the update first'); $('#updText').focus(); return; }
      const rec = { date: $('#updDate').value || todayISO(), topic: $('#updTopic').value, update: text, comments: $('#updComments').value.trim() };
      if (ui.editingUpdate) { Object.assign(S.updates.find((x) => x.id === ui.editingUpdate), rec); toast('Changes saved'); }
      else { S.updates.push(Object.assign({ id: uid() }, rec)); toast('"Update" added'); }
      save(); resetUpdateForm(); renderUpdateList();
    },
    'upd-cancel'() { resetUpdateForm(); },
    'upd-edit'(d) { ui.editingUpdate = d.id; fillUpdateForm(); $('#updText').focus(); $('#updFormTitle').scrollIntoView({ block: 'center' }); },
    'upd-del'(d) { if (confirm('Delete this "Update"?')) { S.updates = S.updates.filter((x) => x.id !== d.id); if (ui.editingUpdate === d.id) resetUpdateForm(); save(); renderUpdateList(); } },
    'upd-copy'(d) {
      const g = S.updates.filter((u) => (u.date || '') === d.date);
      const lines = ['Updates to ' + S.managerName + (d.date ? ' - ' + fmt(d.date) : ''), ''];
      g.forEach((u) => {
        lines.push(u.topic, u.update);
        if (u.comments) lines.push('Comments: ' + u.comments);
        lines.push('');
      });
      copyText(lines.join('\n').trim()).then(() => toast('Copied to clipboard'), () => toast('Copy failed. Select the text and copy it manually.'));
    },

    'close-dlg'() { $('#dlg').close(); },
    'add-topic'() {
      const v = $('#newTopic').value.trim();
      if (!v) return;
      if (S.topics.includes(v)) { toast('That topic already exists'); return; }
      S.topics.push(v); save(); renderSettings(); setStatus(syncState, syncMsg); $('#newTopic').focus();
    },
    'del-topic'(d) { S.topics.splice(d.i, 1); save(); renderSettings(); setStatus(syncState, syncMsg); },
    'export'() { exportData(); },
    'import'() { $('#importFile').click(); },
  };

  async function reauth() {
    try {
      await requestToken('');
      await fetchEmail();
      if (dirty) await push(false); else await pull();
    } catch (e) { setStatus('signin', e.message); toast(e.message); }
  }

  document.addEventListener('click', (e) => {
    const jump = e.target.closest('[data-jump]');
    if (jump) { e.preventDefault(); const t = document.getElementById(jump.dataset.jump); if (t) t.scrollIntoView(); return; }
    const el = e.target.closest('[data-action]');
    if (!el || !A[el.dataset.action]) return;
    A[el.dataset.action](el.dataset, el);
  });

  /* ================= field edits ================= */
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (app.phase !== 'ready') return;

    if (el.matches('select[data-topic-select]') && el.value === '__new') {
      const name = (prompt('Name for the new topic:') || '').trim();
      if (name) {
        if (!S.topics.includes(name)) { S.topics.push(name); save(); }
        refreshTopicSelects();
        el.value = name;
        toast('Topic added');
      } else {
        el.value = S.topics[0];
      }
      return;
    }
    if (el.matches('select[data-topic-filter]')) { ui.todoTopic = el.value; renderTodoList(); return; }

    const d = el.dataset;
    if (!d.f) return;
    const v = el.value;
    switch (d.f) {
      case 'cat-name': S.categories[d.ci].name = v.trim() || 'Untitled'; renderRail(); break;
      case 'item-name': S.categories[d.ci].items[d.ii].name = v; break;
      case 'item-note': S.categories[d.ci].items[d.ii].note = v; break;
      case 'link-label': S.categories[d.ci].items[d.ii].links[d.li].label = v; break;
      case 'link-url': S.categories[d.ci].items[d.ii].links[d.li].url = v.trim(); break;
      case 'pic-project': S.pics[d.pi].project = v; break;
      case 'pic-role': S.pics[d.pi].contacts[d.k].role = v; break;
      case 'pic-name': S.pics[d.pi].contacts[d.k].name = v; break;
      case 'pic-email': {
        S.pics[d.pi].contacts[d.k].email = v.trim();
        const a = el.closest('.crow').querySelector('a.mail');
        if (a) a.href = 'mailto:' + v.trim();
        break;
      }
      case 'todo-status': {
        const t = S.todos.find((x) => x.id === d.id);
        if (t) { t.status = v; save(); renderTodoList(); }
        return;
      }
      case 'manager': S.managerName = v.trim() || 'Manager'; break;
      case 'topic-rename': {
        const i = +d.i, old = S.topics[i], nu = v.trim();
        if (!nu) { el.value = old; return; }
        if (nu !== old && S.topics.includes(nu)) { toast('That topic already exists'); el.value = old; return; }
        S.todos.forEach((t) => { if (t.topic === old) t.topic = nu; });
        S.updates.forEach((u) => { if (u.topic === old) u.topic = nu; });
        if (ui.todoTopic === old) ui.todoTopic = nu;
        S.topics[i] = nu;
        break;
      }
      default: return;
    }
    save();
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'matSearch') { ui.search = e.target.value; renderMatList(); }
  });

  /* ================= boot ================= */
  const syncBtn = document.createElement('button');
  syncBtn.id = 'syncStatus'; syncBtn.type = 'button'; syncBtn.className = 'btn-light sync';
  $('#btnSettings').before(syncBtn);
  syncBtn.addEventListener('click', () => {
    if (syncState === 'conflict') openConflict();
    else if (syncState === 'signin') reauth();
    else if (syncState === 'error') A['sync-now']();
    else openSettings();
  });
  $('#btnSettings').addEventListener('click', openSettings);
  $('#dlg').addEventListener('close', () => { if (app.phase === 'ready') render(); });

  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!validShape(data)) throw new Error('shape');
        if (!confirm('Replace everything with the data from this backup? This also overwrites the Google Sheet.')) return;
        S = data; if (!S.managerName) S.managerName = 'Manager';
        save(); renderSettings(); setStatus(syncState, syncMsg); toast('Backup restored');
      } catch (err) { toast('That file is not a valid backup'); }
    };
    r.readAsText(f);
  });

  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => { if (dirty || pushing) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || app.phase !== 'ready' || dirty || pushing || syncState === 'conflict' || syncState === 'signin') return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    pull();
  });
  window.addEventListener('online', () => { if (app.phase === 'ready' && dirty && syncState !== 'conflict' && syncState !== 'signin') push(false); });
  setInterval(() => {
    if (app.phase === 'ready' && auth.exp && auth.exp < Date.now() && syncState !== 'signin') setStatus('signin', 'Your Google session expired. Click to sign in again.');
  }, 30000);

  if (!CFG.CLIENT_ID || !CFG.SHEET_ID) {
    app.phase = 'config';
    route();
  } else {
    app.phase = 'gate';
    route();
    whenGsi(() => {
      initAuth();
      if (restoreToken()) { fetchEmail().then(startSession); }
      else render();
    });
  }
})();
