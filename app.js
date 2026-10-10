(() => {
  'use strict';

  /* ================= helpers ================= */
  const KEY = 'rrAdminHub.v1';
  const STATUSES = ['Not Started', 'In Progress', 'Completed'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const PAGES = ['materials', 'todo', 'pics', 'updates'];

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
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && ['categories', 'todos', 'pics', 'updates', 'topics'].every((k) => Array.isArray(d[k]))) return d;
      }
    } catch (e) { /* fall through to seed */ }
    return clone(window.SEED);
  }
  let S = load();
  if (!S.managerName) S.managerName = 'Manager';

  function persistLocal() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); }
    catch (e) { toast('Could not save in this browser. Download a backup from Settings.'); }
  }
  // Every edit saves in this browser, then (if sync is on) queues an upload to the Google Sheet.
  function save() {
    persistLocal();
    if (sync.url) { sync.dirty = true; saveSync(); schedulePush(); }
  }

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
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ================= shared pieces ================= */
  function topicOptions(selected, forFilter) {
    let h = forFilter ? `<option value="All"${selected === 'All' ? ' selected' : ''}>All topics</option>` : '';
    S.topics.forEach((t) => { h += `<option value="${esc(t)}"${t === selected ? ' selected' : ''}>${esc(t)}</option>`; });
    if (!forFilter) h += '<option value="__new">+ Add new topic…</option>';
    return h;
  }
  const topicSelect = (id, selected) =>
    `<select id="${id}" data-topic-select>${topicOptions(selected || S.topics[0], false)}</select>`;

  function refreshTopicSelects(pick) {
    $$('select[data-topic-select]').forEach((sel) => {
      const cur = sel.value === '__new' ? S.topics[0] : sel.value;
      sel.innerHTML = topicOptions(cur, false);
      sel.value = S.topics.includes(cur) ? cur : S.topics[0];
    });
    $$('select[data-topic-filter]').forEach((sel) => {
      sel.innerHTML = topicOptions(ui.todoTopic, true);
    });
    if (pick) {
      const sel = $('select[data-topic-select]:focus') || null;
      if (sel) sel.value = pick;
    }
  }

  /* ================= routing & shell ================= */
  function route() {
    const p = location.hash.slice(1);
    ui.page = PAGES.includes(p) ? p : 'materials';
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    $$('#nav a').forEach((a) => {
      if (a.dataset.page === ui.page) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const v = $('#view');
    if (ui.page === 'materials') { v.innerHTML = materialsView(); renderMatList(); }
    else if (ui.page === 'todo') { v.innerHTML = todoView(); renderTodoList(); fillTodoForm(); }
    else if (ui.page === 'pics') { v.innerHTML = picsView(); }
    else { v.innerHTML = updatesView(); renderUpdateList(); fillUpdateForm(); }
    document.title = 'RR Admin Hub';
  }

  /* ================= 1. materials ================= */
  function materialsView() {
    return `
      <div class="page-head">
        <h1>Materials</h1>
        <div class="tools">
          <input id="matSearch" type="search" placeholder="Search links" aria-label="Search materials" value="${esc(ui.search)}">
          <button class="btn ${ui.edit ? 'btn-primary' : ''}" type="button" data-action="toggle-edit" aria-pressed="${ui.edit}">${ui.edit ? 'Done editing' : 'Edit links'}</button>
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
        ? `<div class="cat-head"><input data-f="cat-name" data-ci="${ci}" value="${esc(c.name)}" aria-label="Category name"><button class="btn-quiet" type="button" data-action="del-cat" data-ci="${ci}">Delete category</button></div>`
        : `<div class="cat-head"><h2>${esc(c.name)}</h2><span class="count">${items.length} ${items.length === 1 ? 'item' : 'items'}</span></div>`;
      const body = items.map(({ it, ii }) => (ui.edit ? itemEdit(it, ci, ii) : itemView(it))).join('');
      const add = ui.edit ? `<div class="add-line"><button class="btn-quiet" type="button" data-action="add-item" data-ci="${ci}">+ Add item</button></div>` : '';
      html += `<section class="cat" id="cat-${ci}">${head}<div class="cat-body">${body || '<div class="item"><span class="hint">No items yet.</span></div>'}${add}</div></section>`;
    });
    if (ui.edit) html += `<button class="btn add-cat" type="button" data-action="add-cat">+ Add category</button>`;
    if (!html) html = `<div class="empty">Nothing matches “${esc(ui.search)}”.</div>`;
    $('#matList').innerHTML = html;
  }

  function itemView(it) {
    const links = it.links
      .map((l) => `<a class="lbtn" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.label || l.url)}</a>`)
      .join('');
    return `<div class="item"><div class="item-name">${esc(it.name)}</div><div class="item-links">${links || '<span class="hint">No links yet. Use Edit links to add one.</span>'}</div>${it.note ? `<p class="item-note">${esc(it.note)}</p>` : ''}</div>`;
  }

  function itemEdit(it, ci, ii) {
    const links = it.links
      .map((l, li) => `<div class="link-edit">
          <input data-f="link-label" data-ci="${ci}" data-ii="${ii}" data-li="${li}" value="${esc(l.label)}" placeholder="Button label" aria-label="Button label">
          <input data-f="link-url" data-ci="${ci}" data-ii="${ii}" data-li="${li}" value="${esc(l.url)}" placeholder="https://" aria-label="Link URL">
          <button class="btn-quiet danger" type="button" data-action="del-link" data-ci="${ci}" data-ii="${ii}" data-li="${li}" aria-label="Remove link">Remove</button>
        </div>`).join('');
    return `<div class="item editing">
      <div class="edit-row"><input data-f="item-name" data-ci="${ci}" data-ii="${ii}" value="${esc(it.name)}" aria-label="Item name"><button class="btn-quiet danger" type="button" data-action="del-item" data-ci="${ci}" data-ii="${ii}">Delete item</button></div>
      <div>${links}</div>
      <div><button class="btn-quiet" type="button" data-action="add-link" data-ci="${ci}" data-ii="${ii}">+ Add link</button></div>
      <textarea data-f="item-note" data-ci="${ci}" data-ii="${ii}" rows="2" placeholder="Notes (optional)" aria-label="Notes">${esc(it.note || '')}</textarea>
    </div>`;
  }

  /* ================= 2. to do ================= */
  function todoView() {
    return `
      <div class="page-head"><h1>To do</h1></div>
      <section class="card" aria-labelledby="todoFormTitle">
        <h2 id="todoFormTitle">Add a to do</h2>
        <div id="todoEditing" class="editing-banner" hidden>You are editing an existing to do.</div>
        <div class="form-grid">
          <label>Topic ${topicSelect('todoTopic', S.topics[0])}</label>
          <label>Due date <input type="date" id="todoDue"></label>
          <label>Status <select id="todoStatus">${STATUSES.map((s) => `<option>${s}</option>`).join('')}</select></label>
          <label class="span3">Task <textarea id="todoTask" rows="2" placeholder="What needs to be done?"></textarea></label>
          <label class="span3">Comments <textarea id="todoComments" rows="2" placeholder="Optional notes or links"></textarea></label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" type="button" id="todoSaveBtn" data-action="todo-save">Add to do</button>
          <button class="btn" type="button" id="todoCancelBtn" data-action="todo-cancel" hidden>Cancel</button>
        </div>
      </section>
      <div class="filters">
        <label>Show topic <select data-topic-filter id="todoTopicFilter">${topicOptions(ui.todoTopic, true)}</select></label>
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
    let rows = S.todos.filter((t) => {
      if (ui.todoTopic !== 'All' && t.topic !== ui.todoTopic) return false;
      if (ui.todoStatus === 'open') return t.status !== 'Completed';
      if (ui.todoStatus === 'done') return t.status === 'Completed';
      return true;
    });
    if (!rows.length) {
      $('#todoList').innerHTML = `<div class="empty">${S.todos.length ? 'No to dos match this filter.' : 'No to dos yet. Add your first one above.'}</div>`;
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
    $('#todoSaveBtn').textContent = 'Save changes';
    $('#todoCancelBtn').hidden = false;
    $('#todoEditing').hidden = false;
  }

  function resetTodoForm() {
    ui.editingTodo = null;
    $('#todoDue').value = '';
    $('#todoStatus').value = 'Not Started';
    $('#todoTask').value = '';
    $('#todoComments').value = '';
    $('#todoSaveBtn').textContent = 'Add to do';
    $('#todoCancelBtn').hidden = true;
    $('#todoEditing').hidden = true;
  }

  /* ================= 3. PICs ================= */
  function picsView() {
    const cards = S.pics.map((p, pi) => `
      <section class="card" aria-label="${esc(p.project)}">
        <div class="pic-head">
          <input class="pic-title" data-f="pic-project" data-pi="${pi}" value="${esc(p.project)}" aria-label="Project name">
          <button class="btn-quiet danger" type="button" data-action="del-pic" data-pi="${pi}">Delete project</button>
        </div>
        <div class="crow hd"><span>Market / role</span><span>Name</span><span>Email</span><span></span><span></span></div>
        ${p.contacts.map((c, k) => `
          <div class="crow">
            <input data-f="pic-role" data-pi="${pi}" data-k="${k}" value="${esc(c.role)}" aria-label="Market or role">
            <input data-f="pic-name" data-pi="${pi}" data-k="${k}" value="${esc(c.name)}" aria-label="Name">
            <input data-f="pic-email" data-pi="${pi}" data-k="${k}" value="${esc(c.email)}" type="email" aria-label="Email">
            <a class="mail" href="mailto:${esc(c.email)}">Email</a>
            <button class="btn-quiet danger" type="button" data-action="del-contact" data-pi="${pi}" data-k="${k}" aria-label="Remove contact">Remove</button>
          </div>`).join('')}
        <div style="margin-top:8px"><button class="btn-quiet" type="button" data-action="add-contact" data-pi="${pi}">+ Add contact</button></div>
      </section>`).join('');
    return `
      <div class="page-head">
        <h1>Project PICs</h1>
        <button class="btn" type="button" data-action="add-pic">+ Add project</button>
      </div>
      <div class="pic-grid">${cards || '<div class="empty">No projects yet.</div>'}</div>`;
  }

  /* ================= 4. manager updates ================= */
  function updatesView() {
    return `
      <div class="page-head"><h1>Updates to ${esc(S.managerName)}</h1></div>
      <section class="card" aria-labelledby="updFormTitle">
        <h2 id="updFormTitle">Add an update</h2>
        <div id="updEditing" class="editing-banner" hidden>You are editing an existing update.</div>
        <div class="form-grid">
          <label>Date <input type="date" id="updDate" value="${todayISO()}"></label>
          <label>Topic ${topicSelect('updTopic', S.topics[0])}</label>
          <span></span>
          <label class="span3">Key updates <textarea id="updText" rows="4" placeholder="What should ${esc(S.managerName)} know?"></textarea></label>
          <label class="span3">Comments or questions <textarea id="updComments" rows="2" placeholder="Optional: questions to ask, or the response you got"></textarea></label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" type="button" id="updSaveBtn" data-action="upd-save">Add update</button>
          <button class="btn" type="button" id="updCancelBtn" data-action="upd-cancel" hidden>Cancel</button>
        </div>
      </section>
      <div id="updList"></div>`;
  }

  function renderUpdateList() {
    if (!S.updates.length) { $('#updList').innerHTML = '<div class="empty" style="margin-top:22px">No updates yet. Add your first one above.</div>'; return; }
    const dates = [...new Set(S.updates.map((u) => u.date || ''))].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    $('#updList').innerHTML = dates.map((d) => {
      const g = S.updates.filter((u) => (u.date || '') === d);
      return `<section class="date-group">
        <div class="date-head"><h2>${d ? fmt(d) : 'No date'}</h2><button class="btn" type="button" data-action="upd-copy" data-date="${esc(d)}">Copy as text</button></div>
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
    $('#updSaveBtn').textContent = 'Save changes';
    $('#updCancelBtn').hidden = false;
    $('#updEditing').hidden = false;
  }

  function resetUpdateForm() {
    ui.editingUpdate = null;
    $('#updDate').value = todayISO();
    $('#updText').value = '';
    $('#updComments').value = '';
    $('#updSaveBtn').textContent = 'Add update';
    $('#updCancelBtn').hidden = true;
    $('#updEditing').hidden = true;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((res, rej) => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? res() : rej(); } catch (e) { rej(e); } finally { ta.remove(); }
    });
  }

  /* ================= settings dialog ================= */
  function topicUse(t) {
    return S.todos.filter((x) => x.topic === t).length + S.updates.filter((x) => x.topic === t).length;
  }

  function renderSettings() {
    $('#dlg').innerHTML = `<div class="dlg-in">
      <div class="dlg-top"><h2 id="dlgTitle">Settings &amp; backup</h2><button class="btn-quiet" type="button" data-action="close-dlg">Close</button></div>

      <h3>Reporting manager</h3>
      <label>Name shown on the updates page <input data-f="manager" value="${esc(S.managerName)}"></label>

      <h3>Topics</h3>
      <p class="hint">Used by both the To do and Manager updates pages. Renaming a topic updates every entry using it.</p>
      <div style="margin-top:8px">${S.topics.map((t, i) => {
        const n = topicUse(t);
        return `<div class="topic-row">
          <input data-f="topic-rename" data-i="${i}" value="${esc(t)}" aria-label="Topic name">
          <button class="btn-quiet danger" type="button" data-action="del-topic" data-i="${i}" ${n ? 'disabled' : ''} title="${n ? 'In use by ' + n + ' entries' : 'Delete topic'}">Delete</button>
        </div>`; }).join('')}</div>
      <div class="topic-add"><input id="newTopic" placeholder="New topic name" aria-label="New topic name"><button class="btn" type="button" data-action="add-topic">Add topic</button></div>

      <h3>Google Sheet sync</h3>
      ${sync.url ? `
        <p class="hint" id="syncLine"></p>
        <div class="btn-row"><button class="btn" type="button" data-action="sync-now">Sync now</button><button class="btn-quiet danger" type="button" data-action="sync-disconnect">Turn off sync</button></div>`
      : `
        <p class="hint">Keeps your data in a Google Sheet so it syncs across devices and survives clearing your browser. Setup steps are in SYNC_SETUP.md.</p>
        <label style="margin-top:8px">Web app URL <input id="syncUrl" placeholder="https://script.google.com/macros/s/.../exec" autocomplete="off"></label>
        <label style="margin-top:8px">Secret key <input id="syncKey" type="password" autocomplete="off"></label>
        <div class="btn-row"><button class="btn btn-primary" type="button" data-action="sync-connect">Connect</button></div>`}

      <h3>Backup</h3>
      <p class="hint">${sync.url ? 'A backup file is a second copy that does not depend on Google.' : 'Your edits are saved in this browser only. Download a backup regularly, and use it to move your data to another browser or computer.'}${S.lastExport ? ' Last backup: ' + fmt(S.lastExport) + '.' : ' No backup downloaded yet.'}</p>
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-action="export">Download backup</button>
        <button class="btn" type="button" data-action="import">Restore from backup</button>
        <button class="btn-quiet danger" type="button" data-action="reset">Reset to starting data</button>
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
    renderSettings();
    toast('Backup downloaded');
  }

  /* ================= actions (clicks) ================= */
  const A = {
    'toggle-edit'() { ui.edit = !ui.edit; render(); },

    'add-cat'() { S.categories.push({ name: 'New category', items: [] }); save(); renderMatList(); const i = S.categories.length - 1; const el = $(`[data-f="cat-name"][data-ci="${i}"]`); if (el) { el.focus(); el.select(); } },
    'del-cat'(d) { const c = S.categories[d.ci]; if (confirm(`Delete the category "${c.name}" and its ${c.items.length} items?`)) { S.categories.splice(d.ci, 1); save(); renderMatList(); } },
    'add-item'(d) { S.categories[d.ci].items.push({ id: uid(), name: 'New item', note: '', links: [{ label: 'Open link', url: '' }] }); save(); renderMatList(); const i = S.categories[d.ci].items.length - 1; const el = $(`[data-f="item-name"][data-ci="${d.ci}"][data-ii="${i}"]`); if (el) { el.focus(); el.select(); } },
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
        toast('To do added');
      }
      save(); resetTodoForm();
      if (ui.todoTopic !== 'All' && ui.todoTopic !== rec.topic) ui.todoTopic = 'All';
      $('#todoTopicFilter').value = ui.todoTopic;
      if (ui.todoStatus === 'done' && rec.status !== 'Completed') { ui.todoStatus = 'open'; $$('[data-action="todo-filter"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === 'open'))); }
      renderTodoList();
    },
    'todo-cancel'() { resetTodoForm(); },
    'todo-edit'(d) { ui.editingTodo = d.id; fillTodoForm(); $('#todoTask').focus(); $('#todoFormTitle').scrollIntoView({ block: 'center' }); },
    'todo-del'(d) { if (confirm('Delete this to do?')) { S.todos = S.todos.filter((x) => x.id !== d.id); if (ui.editingTodo === d.id) resetTodoForm(); save(); renderTodoList(); } },

    'add-pic'() { S.pics.push({ id: uid(), project: 'New project', contacts: [{ id: uid(), role: '', name: '', email: '' }] }); save(); $('#view').innerHTML = picsView(); const els = $$('[data-f="pic-project"]'); const el = els[els.length - 1]; if (el) { el.focus(); el.select(); } },
    'del-pic'(d) { const p = S.pics[d.pi]; if (confirm(`Delete the project "${p.project}" and its ${p.contacts.length} contacts?`)) { S.pics.splice(d.pi, 1); save(); $('#view').innerHTML = picsView(); } },
    'add-contact'(d) { S.pics[d.pi].contacts.push({ id: uid(), role: '', name: '', email: '' }); save(); $('#view').innerHTML = picsView(); const els = $$(`[data-f="pic-role"][data-pi="${d.pi}"]`); const el = els[els.length - 1]; if (el) el.focus(); },
    'del-contact'(d) { S.pics[d.pi].contacts.splice(d.k, 1); save(); $('#view').innerHTML = picsView(); },

    'upd-save'() {
      const text = $('#updText').value.trim();
      if (!text) { toast('Write the update first'); $('#updText').focus(); return; }
      const rec = { date: $('#updDate').value || todayISO(), topic: $('#updTopic').value, update: text, comments: $('#updComments').value.trim() };
      if (ui.editingUpdate) { Object.assign(S.updates.find((x) => x.id === ui.editingUpdate), rec); toast('Changes saved'); }
      else { S.updates.push(Object.assign({ id: uid() }, rec)); toast('Update added'); }
      save(); resetUpdateForm(); renderUpdateList();
    },
    'upd-cancel'() { resetUpdateForm(); },
    'upd-edit'(d) { ui.editingUpdate = d.id; fillUpdateForm(); $('#updText').focus(); $('#updFormTitle').scrollIntoView({ block: 'center' }); },
    'upd-del'(d) { if (confirm('Delete this update?')) { S.updates = S.updates.filter((x) => x.id !== d.id); if (ui.editingUpdate === d.id) resetUpdateForm(); save(); renderUpdateList(); } },
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
      S.topics.push(v); save(); renderSettings(); $('#newTopic').focus();
    },
    'del-topic'(d) { S.topics.splice(d.i, 1); save(); renderSettings(); },
    'sync-connect'() { connectSync(); },
    'sync-disconnect'() {
      if (!confirm('Turn off Google Sheet sync on this browser? Your data stays here and in the sheet.')) return;
      clearTimeout(pushTimer);
      sync = { url: '', key: '', rev: 0, dirty: false, lastSync: '' }; saveSync();
      setStatus('off'); renderSettings(); toast('Sync turned off');
    },
    'sync-now'() { if (!sync.url) return; (sync.dirty ? push() : pull()); },
    'conflict-sheet'() { resolveWithSheet(); },
    'conflict-local'() { closeConflict(); push(true); },
    'export'() { exportData(); },
    'import'() { $('#importFile').click(); },
    'reset'() {
      if (confirm('Reset everything to the starting data from your spreadsheet? Your edits will be lost unless you have a backup.' + (sync.url ? ' This also overwrites the data in your Google Sheet.' : ''))) {
        S = clone(window.SEED); save(); renderSettings(); toast('Reset to starting data');
      }
    },
  };

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

  /* ================= Google Sheet sync ================= */
  const SYNC_KEY = 'rrAdminHub.sync';
  const SYNC_DEFAULT = { url: '', key: '', rev: 0, dirty: false, lastSync: '' };
  let sync = (() => {
    try { return Object.assign({}, SYNC_DEFAULT, JSON.parse(localStorage.getItem(SYNC_KEY) || '{}')); }
    catch (e) { return Object.assign({}, SYNC_DEFAULT); }
  })();
  let syncState = sync.url ? 'checking' : 'off';
  let syncMsg = '';
  let pushing = false;
  let pushTimer = null;

  function saveSync() { try { localStorage.setItem(SYNC_KEY, JSON.stringify(sync)); } catch (e) { /* ignore */ } }

  const SYNC_LABELS = { off: 'Sync off', checking: 'Checking…', saving: 'Saving…', synced: 'Synced', error: 'Not synced (retry)', conflict: 'Resolve sync conflict' };

  function setStatus(state, msg) {
    syncState = state; syncMsg = msg || '';
    const b = $('#syncStatus');
    if (b) { b.innerHTML = `<span class="dot dot-${state}"></span>${SYNC_LABELS[state]}`; b.title = syncMsg; }
    const line = $('#syncLine');
    if (line) {
      const t = sync.lastSync ? new Date(sync.lastSync).toLocaleString() : 'never';
      line.textContent = `${SYNC_LABELS[state]}. Last synced: ${t}.${syncMsg ? ' ' + syncMsg : ''}`;
    }
  }

  async function api(action, extra) {
    let res, text;
    try {
      res = await fetch(sync.url, { method: 'POST', body: JSON.stringify(Object.assign({ key: sync.key, action }, extra || {})) });
      text = await res.text();
    } catch (e) {
      throw new Error('Could not reach Google. Your edits are safe in this browser and will sync when you are back online.');
    }
    let j;
    try { j = JSON.parse(text); }
    catch (e) { throw new Error('The sheet script did not answer correctly. Check that the web app is deployed with access set to "Anyone".'); }
    if (!j.ok && !j.conflict) throw new Error(j.error === 'unauthorized' ? 'Wrong secret key.' : (j.error || 'Sync failed.'));
    return j;
  }

  function markSynced() { sync.lastSync = new Date().toISOString(); saveSync(); setStatus('synced'); }

  function schedulePush() {
    setStatus(syncState === 'conflict' ? 'conflict' : 'saving', syncMsg);
    if (syncState === 'conflict') return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push(false), 1500);
  }

  async function push(force) {
    if (!sync.url) return;
    if (pushing) { clearTimeout(pushTimer); pushTimer = setTimeout(() => push(force), 800); return; }
    pushing = true;
    setStatus('saving');
    try {
      const snapshot = JSON.stringify(S);
      const r = await api('save', { baseRev: sync.rev, force: !!force, data: S });
      if (r.conflict) { openConflict(); return; }
      sync.rev = r.rev;
      sync.dirty = JSON.stringify(S) !== snapshot; // edited again while uploading
      saveSync();
      if (sync.dirty) schedulePush(); else markSynced();
    } catch (e) {
      setStatus('error', e.message);
    } finally {
      pushing = false;
    }
  }

  async function pull() {
    if (!sync.url) return;
    setStatus('checking');
    try {
      const r = await api('load');
      if (r.data === null) { sync.rev = r.rev; saveSync(); await push(false); return; }
      if (r.rev === sync.rev) { if (sync.dirty) await push(false); else markSynced(); return; }
      if (sync.dirty) { openConflict(); return; }
      adopt(r.data, r.rev);
    } catch (e) {
      setStatus('error', e.message);
    }
  }

  function adopt(data, rev) {
    if (!['categories', 'todos', 'pics', 'updates', 'topics'].every((k) => Array.isArray(data[k]))) throw new Error('The sheet data looks damaged.');
    S = data;
    if (!S.managerName) S.managerName = 'Manager';
    persistLocal();
    sync.rev = rev; sync.dirty = false; saveSync();
    markSynced();
    render();
  }

  function openConflict() {
    setStatus('conflict', 'The Google Sheet and this browser have different versions.');
    let d = $('#dlgConflict');
    if (!d) { d = document.createElement('dialog'); d.id = 'dlgConflict'; document.body.appendChild(d); }
    d.innerHTML = `<div class="dlg-in">
      <h2>Which version do you want to keep?</h2>
      <p class="hint" style="margin:8px 0 14px">The Google Sheet has data that differs from this browser, for example because you edited on another device. You can keep only one.</p>
      <div class="btn-row" style="flex-direction:column;align-items:stretch">
        <button class="btn btn-primary" type="button" data-action="conflict-sheet">Use the Google Sheet version</button>
        <button class="btn" type="button" data-action="conflict-local">Keep this browser's version and overwrite the sheet</button>
        <button class="btn-quiet" type="button" data-action="export">Download this browser's data first</button>
      </div></div>`;
    if (!d.open) { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); }
  }

  function closeConflict() { const d = $('#dlgConflict'); if (d && d.open) d.close(); }

  async function resolveWithSheet() {
    closeConflict();
    setStatus('checking');
    try {
      const r = await api('load');
      if (r.data === null) { sync.dirty = true; await push(true); return; }
      adopt(r.data, r.rev);
      toast('Loaded the Google Sheet version');
    } catch (e) { setStatus('error', e.message); }
  }

  async function connectSync() {
    const url = ($('#syncUrl').value || '').trim();
    const key = $('#syncKey').value;
    if (!/^https:\/\/script\.google\.com\/.+\/exec/.test(url)) { toast('Paste the Web app URL that ends in /exec'); return; }
    if (!key) { toast('Enter your secret key'); return; }
    sync = { url, key, rev: 0, dirty: false, lastSync: '' };
    saveSync();
    setStatus('checking');
    try {
      const r = await api('load');
      sync.rev = r.rev;
      if (r.data === null) {
        sync.dirty = true; saveSync();
        await push(false);
        renderSettings();
        toast('Connected. Your data is now in the Google Sheet.');
      } else {
        sync.dirty = true; saveSync();
        $('#dlg').close();
        openConflict();
      }
    } catch (e) {
      sync = Object.assign({}, SYNC_DEFAULT); saveSync();
      setStatus('off');
      toast(e.message);
    }
  }

  /* ================= boot ================= */
  $('#btnSettings').addEventListener('click', openSettings);
  const syncBtn = document.createElement('button');
  syncBtn.id = 'syncStatus'; syncBtn.type = 'button'; syncBtn.className = 'btn-light sync';
  $('#btnSettings').before(syncBtn);
  syncBtn.addEventListener('click', () => {
    if (syncState === 'conflict') openConflict();
    else if (syncState === 'error') A['sync-now']();
    else openSettings();
  });
  setStatus(syncState, '');
  if (sync.url) pull();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !sync.url || sync.dirty || pushing || syncState === 'conflict') return;
    const ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    pull();
  });
  window.addEventListener('online', () => { if (sync.url && sync.dirty && syncState !== 'conflict') push(false); });
  $('#dlg').addEventListener('close', () => render());
  $('#importFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!['categories', 'todos', 'pics', 'updates', 'topics'].every((k) => Array.isArray(data[k]))) throw new Error('shape');
        if (!confirm('Replace everything on this site with the data from this backup?')) return;
        S = data; if (!S.managerName) S.managerName = 'Manager';
        save(); renderSettings(); toast('Backup restored');
      } catch (err) { toast('That file is not a valid backup'); }
    };
    r.readAsText(f);
  });
  window.addEventListener('hashchange', route);
  route();
})();
