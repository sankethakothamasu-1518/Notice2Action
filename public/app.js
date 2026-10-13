'use strict';
/* Notice2Action frontend — talks to the REST API only. */

const $ = (id) => document.getElementById(id);
const SAMPLE_NOTICE = `HOSTEL FEE PAYMENT AND ROOM ALLOTMENT

All hostel residents are hereby informed that the hostel fee for the odd semester must be paid before 25 October 2026. The fee can be paid online through the student portal or at the accounts counter.

Students who fail to remit the fee on or before the last date will not be allotted a room. Room allotment will be carried out on 30 October 2026.

Eligibility for continued hostel accommodation: students must have a minimum attendance of 75 percent in the previous semester and no pending disciplinary case.

Required documents to be submitted at the warden office: a photocopy of the college identity card, one passport size photograph, and the previous semester mark sheet.

Please collect the room allotment slip from the warden office within 7 days of the allotment date.`;

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body.data;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const prioBadge = (p) => `<span class="badge p-${esc(p)}">${esc(p)}</span>`;
const fmtDate = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined,
  { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'no date found');
const daysLabel = (d) => {
  if (d == null) return '';
  if (d < 0) return `<span class="badge p-high">${Math.abs(d)} day(s) overdue</span>`;
  if (d === 0) return '<span class="badge p-high">due today</span>';
  if (d <= 7) return `<span class="badge p-medium">in ${d} day(s)</span>`;
  return `<span class="badge p-low">in ${d} day(s)</span>`;
};

/* ------------------------------------------------------------- navigation */
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
    const v = btn.dataset.view;
    if (v === 'dashboard') loadDashboard();
    if (v === 'notices') loadNotices();
    if (v === 'deadlines') loadDeadlines();
    if (v === 'checklist') loadChecklist();
  });
});

/* ------------------------------------------------------------------- boot */
async function boot() {
  $('upRefDate').value = new Date().toISOString().slice(0, 10);
  try {
    const users = await api('/api/users');
    $('upUser').innerHTML = '<option value="">— none —</option>' +
      users.map((u) => `<option value="${u.id}">${esc(u.name)} (${esc(u.role)})</option>`).join('');
  } catch (_) { $('upUser').innerHTML = '<option value="">— none —</option>'; }
  loadDashboard();
}

/* -------------------------------------------------------------- dashboard */
async function loadDashboard() {
  const [stats, deadlines, notices] = await Promise.all([
    api('/api/stats'), api('/api/deadlines?upcoming=true'), api('/api/notices?limit=5')
  ]);
  $('statCards').innerHTML = [
    ['notices', 'Notices analysed', ''], ['analyzed', 'Successfully analysed', 'good'],
    ['deadlines', 'Deadlines extracted', ''],
    ['open_tasks', 'Open tasks', ''], ['due_soon', 'Due within 7 days', 'soon'],
    ['overdue_tasks', 'Overdue', 'hot'], ['documents', 'Required documents', ''],
    ['done_tasks', 'Tasks completed', 'good']
  ].map(([k, lab, cls]) => `<div class="card ${cls}"><div class="num">${stats[k]}</div><div class="lab">${lab}</div></div>`).join('');

  $('upcomingDeadlines').innerHTML = deadlines.items.length
    ? deadlines.items.slice(0, 6).map((d) => `
      <div class="item">
        <h3>${esc(d.label)}</h3>
        <div class="badges">${prioBadge(d.priority)}${daysLabel(d.days_left)}
          <span class="badge">${fmtDate(d.due_date)}</span></div>
        <div class="meta"><span>${esc(d.notice_title)}</span></div>
      </div>`).join('')
    : '<div class="empty">No dated deadlines yet.</div>';

  $('recentNotices').innerHTML = notices.items.length
    ? notices.items.map((n) => `
      <div class="item">
        <h3>${esc(n.title)}</h3>
        <div class="meta"><span>${esc(n.main_subject || '')}</span>
          <span>${n.deadline_count || 0} deadline(s)</span>
          <span>${n.checklist_done || 0}/${n.checklist_total || 0} tasks done</span>
          <span>${esc(n.source_type)}</span></div>
      </div>`).join('')
    : '<div class="empty">No notices yet — add one from the "New notice" tab.</div>';
}

/* ----------------------------------------------------------------- upload */
$('btnLoadSample').addEventListener('click', () => {
  $('upText').value = SAMPLE_NOTICE;
  $('upTitle').value = 'Hostel Fee Payment and Room Allotment';
});

$('btnPreview').addEventListener('click', async () => {
  const text = $('upText').value.trim();
  if (text.length < 20) return setStatus('Paste at least 20 characters of notice text first.', 'err');
  setStatus('<span class="spinner"></span>Analysing (nothing is saved)…');
  try {
    const data = await api('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ref_date: $('upRefDate').value || undefined })
    });
    $('previewBody').innerHTML = renderAnalysis(data);
    $('previewCard').classList.remove('hidden');
    setStatus('Preview ready. Nothing was stored.', 'ok');
  } catch (e) { setStatus(e.message, 'err'); }
});
$('previewClose').addEventListener('click', () => $('previewCard').classList.add('hidden'));

$('btnAnalyze').addEventListener('click', async () => {
  const text = $('upText').value.trim();
  const file = $('upFile').files[0];
  if (!file && text.length < 20) return setStatus('Paste notice text or choose a file.', 'err');
  setStatus('<span class="spinner"></span>Extracting text and running the NLP analysis…');
  $('btnAnalyze').disabled = true;
  try {
    const fd = new FormData();
    if (file) fd.append('file', file);
    if (text) fd.append('text', text);
    if ($('upTitle').value.trim()) fd.append('title', $('upTitle').value.trim());
    if ($('upRefDate').value) fd.append('ref_date', $('upRefDate').value);
    if ($('upUser').value) fd.append('uploaded_by', $('upUser').value);
    const data = await api('/api/notices', { method: 'POST', body: fd });
    $('previewBody').innerHTML = renderAnalysis(data);
    $('previewCard').classList.remove('hidden');
    setStatus(`Saved as notice #${data.id} (${esc(data.source_type)}).`, 'ok');
    $('upText').value = ''; $('upFile').value = ''; $('upTitle').value = '';
    toast(`Notice #${data.id} analysed`);
  } catch (e) { setStatus(e.message, 'err'); }
  finally { $('btnAnalyze').disabled = false; }
});
function setStatus(html, cls = '') { $('uploadStatus').className = `status ${cls}`; $('uploadStatus').innerHTML = html; }

/* -------------------------------------------------------- analysis render */
function renderAnalysis(n) {
  const list = (arr, f, empty) => (arr && arr.length)
    ? `<ul class="clean">${arr.map(f).join('')}</ul>` : `<div class="empty">${empty}</div>`;
  return `
    <h3>${esc(n.title)}</h3>
    <div class="badges">
      ${n.id ? `<span class="badge">#${n.id}</span>` : '<span class="badge">preview</span>'}
      <span class="badge">${esc(n.source_type || 'text')}</span>
      ${(n.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join('')}
      ${n.word_count ? `<span class="badge">${n.word_count} words</span>` : ''}
      ${n.reading_time_min ? `<span class="badge">~${n.reading_time_min} min read</span>` : ''}
    </div>
    <div class="section-title">Main subject</div>
    <div>${esc(n.main_subject || '—')}</div>
    <div class="section-title">Summary</div>
    <div class="summary">${esc(n.summary || '—')}</div>
    <div class="section-title">Key points</div>
    ${list(n.key_points, (p) => `<li>${esc(p)}</li>`, 'No key points extracted.')}
    <div class="section-title">Deadlines</div>
    ${list(n.deadlines, (d) => `<li>${prioBadge(d.priority)} <strong>${esc(d.due_date || d.due_date_text || 'no date')}</strong> — ${esc(d.label)}
        ${d.snippet ? `<div class="snippet">${esc(d.snippet)}</div>` : ''}</li>`, 'No dated deadlines found.')}
    <div class="section-title">Eligibility criteria</div>
    ${list(n.eligibility, (e) => `<li>${esc(e.criterion)}</li>`, 'No eligibility criteria found.')}
    <div class="section-title">Required documents</div>
    ${list(n.required_documents, (d) => `<li><span class="badge doc">${esc(d.document_name)}</span></li>`, 'No required documents found.')}
    <div class="section-title">Action checklist (${(n.checklist || []).length})</div>
    ${list(n.checklist, (c) => `<li>${prioBadge(c.priority)} ${esc(c.task)}${c.due_date ? ` — <strong>${fmtDate(c.due_date)}</strong>` : ''}</li>`, 'No action items generated.')}
    ${n.raw_text ? `<details class="raw"><summary>Original notice text (stored for verification)</summary><pre>${esc(n.raw_text)}</pre></details>` : ''}`;
}

/* ---------------------------------------------------------------- notices */
$('btnRefreshNotices').addEventListener('click', loadNotices);
$('searchBox').addEventListener('input', debounce(loadNotices, 320));
$('statusFilter').addEventListener('change', loadNotices);

async function loadNotices() {
  const q = $('searchBox').value.trim();
  const st = $('statusFilter').value;
  const data = await api(`/api/notices?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}${st ? `&status=${st}` : ''}`);
  if (!data.items.length) { $('noticesList').innerHTML = '<div class="empty">No notices match.</div>'; return; }
  $('noticesList').innerHTML = data.items.map((n) => `
    <div class="item">
      <h3>${esc(n.title)}</h3>
      <div>${esc(n.summary || n.main_subject || '')}</div>
      <div class="badges">
        <span class="badge">#${n.id}</span>
        <span class="badge">${esc(n.source_type)}</span>
        <span class="badge ${n.status === 'analyzed' ? 'ok' : 'p-high'}">${esc(n.status)}</span>
        <span class="badge">${n.deadline_count || 0} deadline(s)</span>
        <span class="badge">${n.checklist_done || 0}/${n.checklist_total || 0} tasks</span>
      </div>
      <div class="meta"><span>${esc(n.created_at)}</span>${n.uploader ? `<span>by ${esc(n.uploader)}</span>` : ''}</div>
      <div class="row tight" style="margin-top:10px">
        <button class="ghost small" data-open="${n.id}">Open analysis</button>
        <button class="ghost small" data-re="${n.id}">Re-analyze</button>
        <button class="danger small" data-del="${n.id}">Delete</button>
      </div>
      <div id="detail-${n.id}" class="hidden" style="margin-top:12px"></div>
    </div>`).join('');

  $('noticesList').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
    const box = $(`detail-${b.dataset.open}`);
    if (!box.classList.contains('hidden')) return box.classList.add('hidden');
    box.innerHTML = '<div class="status"><span class="spinner"></span>Loading…</div>';
    box.classList.remove('hidden');
    box.innerHTML = renderAnalysis(await api(`/api/notices/${b.dataset.open}`));
  }));
  $('noticesList').querySelectorAll('[data-re]').forEach((b) => b.addEventListener('click', async () => {
    const n = await api(`/api/notices/${b.dataset.re}/reanalyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    toast(`Notice #${n.id} re-analysed`); loadNotices(); loadDashboard();
  }));
  $('noticesList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Delete notice #${b.dataset.del} and all its extracted rows?`)) return;
    await api(`/api/notices/${b.dataset.del}`, { method: 'DELETE' });
    toast('Notice deleted'); loadNotices(); loadDashboard();
  }));
}

/* -------------------------------------------------------------- deadlines */
$('onlyUpcoming').addEventListener('change', loadDeadlines);
async function loadDeadlines() {
  const data = await api(`/api/deadlines${$('onlyUpcoming').checked ? '?upcoming=true' : ''}`);
  $('deadlinesList').innerHTML = data.items.length
    ? data.items.map((d) => `
      <div class="item">
        <h3>${esc(d.label)}</h3>
        <div class="badges">${prioBadge(d.priority)}
          <span class="badge">${fmtDate(d.due_date)}</span>
          <span class="badge">${esc(d.due_date_text || '')}</span>
          ${daysLabel(d.days_left)}</div>
        <div class="meta"><span>${esc(d.notice_title)} (#${d.notice_id})</span></div>
        ${d.snippet ? `<div class="snippet">${esc(d.snippet)}</div>` : ''}
      </div>`).join('')
    : '<div class="empty">No deadlines extracted yet.</div>';
}

/* -------------------------------------------------------------- checklist */
$('btnRefreshChecklist').addEventListener('click', loadChecklist);
$('clFilter').addEventListener('change', loadChecklist);
async function loadChecklist() {
  const st = $('clFilter').value;
  const data = await api(`/api/checklist${st ? `?status=${st}` : ''}`);
  const all = await api('/api/checklist');
  const total = all.items.length, done = all.items.filter((i) => i.is_done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progressWrap').innerHTML = `<div class="progress-label">${done} of ${total} tasks completed (${pct}%)</div>
    <div class="bar"><i style="width:${pct}%"></i></div>`;

  $('checklistBody').innerHTML = data.items.length
    ? data.items.map((c) => `
      <div class="task ${c.is_done ? 'done' : ''}">
        <input type="checkbox" data-tick="${c.id}" ${c.is_done ? 'checked' : ''} />
        <div class="t-text">
          <div>${esc(c.task)}</div>
          <div class="t-sub">
            ${prioBadge(c.priority)}
            ${c.due_date ? `<span class="badge">${fmtDate(c.due_date)}</span>` : ''}
            ${daysLabel(c.days_left)}
            <span class="badge">${esc(c.source)}</span>
            <span>${esc(c.notice_title)}</span>
          </div>
        </div>
        <button class="ghost small" data-rm="${c.id}">✕</button>
      </div>`).join('')
    : '<div class="empty">No tasks here.</div>';

  $('checklistBody').querySelectorAll('[data-tick]').forEach((cb) => cb.addEventListener('change', async () => {
    await api(`/api/checklist/${cb.dataset.tick}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_done: cb.checked })
    });
    loadChecklist(); loadDashboard();
  }));
  $('checklistBody').querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/checklist/${b.dataset.rm}`, { method: 'DELETE' });
    toast('Task deleted'); loadChecklist(); loadDashboard();
  }));
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

boot().catch((e) => toast(`Startup error: ${e.message}`));
