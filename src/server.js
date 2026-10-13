'use strict';
/**
 * Notice2Action API + static web app.
 * Express + SQLite (node:sqlite). See README.md for endpoints.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { db, DB_PATH, logActivity } = require('./db');
const { analyze } = require('./nlp');
const { extractText, ocrAvailable } = require('./ingest');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_UPLOAD_MB = 12;

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 }
});

/* ------------------------------------------------------------- helpers */

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, message, status = 400) => res.status(status).json({ success: false, error: message });

function parseJSON(value, fallback) {
  try { const v = JSON.parse(value); return v ?? fallback; } catch (_) { return fallback; }
}

const NOTICE_SELECT = `
  SELECT n.*, u.name AS uploader_name
  FROM notices n LEFT JOIN users u ON u.id = n.uploaded_by`;

function shapeNotice(row, { detail = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    title: row.title,
    source_type: row.source_type,
    file_name: row.file_name,
    main_subject: row.main_subject,
    summary: row.summary,
    tags: parseJSON(row.tags, []),
    word_count: row.word_count,
    reading_time_min: row.reading_time_min,
    status: row.status,
    error_message: row.error_message,
    analysis_meta: parseJSON(row.analysis_meta, []),
    uploader: row.uploader_name || null,
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (!detail) {
    base.deadline_count = row.deadline_count != null ? row.deadline_count : undefined;
    base.checklist_total = row.checklist_total != null ? row.checklist_total : undefined;
    base.checklist_done = row.checklist_done != null ? row.checklist_done : undefined;
    return base;
  }
  const id = row.id;
  const q = (sql) => db.prepare(sql).all(id);
  return {
    ...base,
    raw_text: row.raw_text,
    key_points: q('SELECT point, rank FROM key_points WHERE notice_id=? ORDER BY rank').map((r) => r.point),
    deadlines: q("SELECT id,label,due_date,due_date_text,priority,snippet FROM deadlines WHERE notice_id=? ORDER BY COALESCE(due_date,'9999')"),
    eligibility: q('SELECT id,criterion,snippet FROM eligibility_criteria WHERE notice_id=?'),
    required_documents: q('SELECT id,document_name,snippet FROM required_documents WHERE notice_id=?'),
    checklist: q('SELECT id,task,due_date,priority,is_done,done_at,sort_order,source FROM checklist_items WHERE notice_id=? ORDER BY is_done, sort_order'),
    activity: q('SELECT id,action,detail,created_at FROM activity_log WHERE notice_id=? ORDER BY id DESC LIMIT 25')
  };
}

/** Persist a fresh analysis for a notice row (replaces previous derived rows). */
const persistAnalysis = (noticeId, result) => {
  db.prepare('DELETE FROM key_points WHERE notice_id=?').run(noticeId);
  db.prepare('DELETE FROM deadlines WHERE notice_id=?').run(noticeId);
  db.prepare('DELETE FROM eligibility_criteria WHERE notice_id=?').run(noticeId);
  db.prepare('DELETE FROM required_documents WHERE notice_id=?').run(noticeId);
  db.prepare('DELETE FROM checklist_items WHERE notice_id=?').run(noticeId);

  const kp = db.prepare('INSERT INTO key_points (notice_id, point, rank) VALUES (?,?,?)');
  result.key_points.forEach((p, i) => kp.run(noticeId, p, i));

  const dl = db.prepare('INSERT INTO deadlines (notice_id,label,due_date,due_date_text,priority,snippet) VALUES (?,?,?,?,?,?)');
  for (const d of result.deadlines) dl.run(noticeId, d.label, d.due_date, d.due_date_text, d.priority, d.snippet);

  const el = db.prepare('INSERT INTO eligibility_criteria (notice_id,criterion,snippet) VALUES (?,?,?)');
  for (const e of result.eligibility) el.run(noticeId, e.criterion, e.snippet);

  const dc = db.prepare('INSERT INTO required_documents (notice_id,document_name,snippet) VALUES (?,?,?)');
  for (const d of result.required_documents) dc.run(noticeId, d.document_name, d.snippet);

  const ck = db.prepare('INSERT INTO checklist_items (notice_id,task,due_date,priority,sort_order,source) VALUES (?,?,?,?,?,?)');
  for (const c of result.checklist) ck.run(noticeId, c.task, c.due_date, c.priority, c.sort_order, c.source);

  db.prepare(`UPDATE notices SET main_subject=?, summary=?, tags=?, word_count=?, reading_time_min=?,
              status='analyzed', error_message=NULL, analysis_meta=?, updated_at=datetime('now') WHERE id=?`)
    .run(result.main_subject, result.summary, JSON.stringify(result.tags), result.stats.words,
      result.stats.reading_time_min, JSON.stringify([{ ref_date: result.refDate, stats: result.stats, engine: 'rule-based NLP v1' }]), noticeId);
};

/* ----------------------------------------------------------------- users */

app.get('/api/health', (req, res) => ok(res, {
  status: 'up',
  service: 'Notice2Action API',
  version: '1.0.0',
  database: path.basename(DB_PATH),
  ocr_available: ocrAvailable(),
  time: new Date().toISOString()
}));

app.get('/api/users', (req, res) => ok(res, db.prepare('SELECT id,name,email,role,department,created_at FROM users ORDER BY id').all()));

app.post('/api/users', (req, res) => {
  const { name, email, role = 'student', department = null } = req.body || {};
  if (!name || !email) return fail(res, 'name and email are required');
  try {
    const info = db.prepare('INSERT INTO users (name,email,role,department) VALUES (?,?,?,?)').run(name, email, role, department);
    logActivity(null, 'user.created', `${email}`);
    return ok(res, db.prepare('SELECT id,name,email,role,department,created_at FROM users WHERE id=?').get(info.lastInsertRowid), 201);
  } catch (e) {
    return fail(res, /UNIQUE/.test(e.message) ? 'a user with that email already exists' : e.message);
  }
});

/* --------------------------------------------------------------- notices */

app.get('/api/notices', (req, res) => {
  const { status, q, limit = 50, offset = 0, sort = 'recent' } = req.query;
  const where = [];
  const params = [];
  if (status) { where.push('n.status = ?'); params.push(status); }
  if (q) { where.push('(n.title LIKE ? OR n.summary LIKE ? OR n.raw_text LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const order = sort === 'oldest' ? 'n.created_at ASC' : sort === 'title' ? 'n.title ASC' : 'n.created_at DESC';
  const sql = `${NOTICE_SELECT}
    LEFT JOIN (SELECT notice_id, COUNT(*) deadline_count FROM deadlines GROUP BY notice_id) d ON d.notice_id = n.id
    LEFT JOIN (SELECT notice_id, COUNT(*) checklist_total, SUM(is_done) checklist_done FROM checklist_items GROUP BY notice_id) c ON c.notice_id = n.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${order} LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, Number(limit), Number(offset));
  const total = db.prepare(`SELECT COUNT(*) c FROM notices n ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...params).c;
  return ok(res, { total, count: rows.length, items: rows.map((r) => shapeNotice(r)) });
});

app.get('/api/notices/:id', (req, res) => {
  const row = db.prepare(`${NOTICE_SELECT} WHERE n.id=?`).get(req.params.id);
  if (!row) return fail(res, 'notice not found', 404);
  return ok(res, shapeNotice(row, { detail: true }));
});

app.get('/api/stats', (req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p).c;
  return ok(res, {
    notices: one('SELECT COUNT(*) c FROM notices'),
    analyzed: one("SELECT COUNT(*) c FROM notices WHERE status='analyzed'"),
    failed: one("SELECT COUNT(*) c FROM notices WHERE status='failed'"),
    deadlines: one('SELECT COUNT(*) c FROM deadlines'),
    open_tasks: one('SELECT COUNT(*) c FROM checklist_items WHERE is_done=0'),
    done_tasks: one('SELECT COUNT(*) c FROM checklist_items WHERE is_done=1'),
    overdue_tasks: one("SELECT COUNT(*) c FROM checklist_items WHERE is_done=0 AND due_date IS NOT NULL AND due_date < date('now')"),
    due_soon: one("SELECT COUNT(*) c FROM checklist_items WHERE is_done=0 AND due_date IS NOT NULL AND due_date BETWEEN date('now') AND date('now','+7 day')"),
    documents: one('SELECT COUNT(*) c FROM required_documents'),
    users: one('SELECT COUNT(*) c FROM users')
  });
});

app.get('/api/deadlines', (req, res) => {
  const upcomingOnly = req.query.upcoming === 'true';
  const rows = db.prepare(`
    SELECT d.id,d.label,d.due_date,d.due_date_text,d.priority,d.snippet,n.id notice_id,n.title notice_title,
           CASE WHEN d.due_date IS NULL THEN NULL ELSE CAST(julianday(d.due_date)-julianday(date('now')) AS INTEGER) END AS days_left
    FROM deadlines d JOIN notices n ON n.id=d.notice_id
    ${upcomingOnly ? "WHERE d.due_date IS NOT NULL AND d.due_date >= date('now')" : ''}
    ORDER BY CASE WHEN d.due_date IS NULL THEN 1 ELSE 0 END, d.due_date ASC`).all();
  return ok(res, { count: rows.length, items: rows });
});

app.get('/api/checklist', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status === 'open') where.push('c.is_done=0');
  if (req.query.status === 'done') where.push('c.is_done=1');
  if (req.query.notice_id) { where.push('c.notice_id=?'); params.push(req.query.notice_id); }
  const rows = db.prepare(`
    SELECT c.*, n.title notice_title,
      CASE WHEN c.due_date IS NULL THEN NULL ELSE CAST(julianday(c.due_date)-julianday(date('now')) AS INTEGER) END AS days_left
    FROM checklist_items c JOIN notices n ON n.id=c.notice_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.is_done ASC, CASE WHEN c.due_date IS NULL THEN 1 ELSE 0 END, c.due_date ASC, c.sort_order ASC`).all(...params);
  return ok(res, { count: rows.length, items: rows });
});

/**
 * Create + analyze a notice.
 * Accepts either a multipart upload (field "file", optional field "title") or JSON {text,title,uploaded_by}.
 * Optional "ref_date" (YYYY-MM-DD) sets the reference day used to resolve relative dates.
 */
app.post('/api/notices', upload.single('file'), async (req, res) => {
  const refDate = req.body?.ref_date || undefined;
  let text = (req.body?.text || '').trim();
  let title = (req.body?.title || '').trim();
  let fileName = req.file ? req.file.originalname : null;
  let sourceType = 'text';
  let extraction = 'pasted text';
  const meta = [];

  try {
    if (req.file) {
      const out = await extractText(req.file.buffer, req.file.originalname, req.file.mimetype);
      text = out.text;
      sourceType = out.source_type;
      extraction = out.extraction;
      if (!title) title = path.parse(req.file.originalname).name.replace(/[_-]+/g, ' ');
    }
    if (!text || text.trim().length < 20) {
      return fail(res, 'Please provide notice text (at least 20 characters) or upload a readable PDF/DOCX/TXT file.');
    }
    if (!title) title = text.trim().split(/\n/)[0].slice(0, 90) || 'Untitled notice';

    const uploadedBy = req.body?.uploaded_by ? Number(req.body.uploaded_by) : null;
    const info = db.prepare(`INSERT INTO notices (title,source_type,file_name,raw_text,uploaded_by,status)
      VALUES (?,?,?,?,?,'processing')`).run(title, sourceType, fileName, text, uploadedBy);
    const noticeId = Number(info.lastInsertRowid);

    const result = analyze(text, { refDate });
    persistAnalysis(noticeId, result);
    meta.push({ source_type: sourceType, extraction });
    logActivity(noticeId, 'notice.analyzed', `${extraction}; ${result.deadlines.length} deadline(s), ${result.checklist.length} task(s)`);

    const row = db.prepare(`${NOTICE_SELECT} WHERE n.id=?`).get(noticeId);
    const shaped = shapeNotice(row, { detail: true });
    shaped.extraction = extraction;
    return ok(res, shaped, 201);
  } catch (e) {
    // record the failure if the row was already created
    try {
      const existing = db.prepare('SELECT id FROM notices ORDER BY id DESC LIMIT 1').get();
      if (existing && fileName) {
        db.prepare("UPDATE notices SET status='failed', error_message=? WHERE id=?").run(e.message, existing.id);
        logActivity(existing.id, 'notice.failed', e.message);
      }
    } catch (_) {}
    return fail(res, e.message || 'Failed to process the notice', 422);
  }
});

/** Re-run the NLP pipeline on the stored text (optionally with a new reference date). */
app.post('/api/notices/:id/reanalyze', (req, res) => {
  const row = db.prepare('SELECT * FROM notices WHERE id=?').get(req.params.id);
  if (!row) return fail(res, 'notice not found', 404);
  if (!row.raw_text) return fail(res, 'notice has no stored text to re-analyze', 422);
  const result = analyze(row.raw_text, { refDate: req.body?.ref_date });
  persistAnalysis(row.id, result);
  logActivity(row.id, 'notice.reanalyzed', `${result.deadlines.length} deadline(s), ${result.checklist.length} task(s)`);
  return ok(res, shapeNotice(db.prepare(`${NOTICE_SELECT} WHERE n.id=?`).get(row.id), { detail: true }));
});

app.patch('/api/notices/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM notices WHERE id=?').get(req.params.id);
  if (!row) return fail(res, 'notice not found', 404);
  const title = req.body?.title ?? row.title;
  db.prepare("UPDATE notices SET title=?, updated_at=datetime('now') WHERE id=?").run(title, row.id);
  return ok(res, shapeNotice(db.prepare(`${NOTICE_SELECT} WHERE n.id=?`).get(row.id), { detail: true }));
});

app.delete('/api/notices/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM notices WHERE id=?').get(req.params.id);
  if (!row) return fail(res, 'notice not found', 404);
  db.prepare('DELETE FROM notices WHERE id=?').run(row.id);
  return ok(res, { deleted: Number(row.id) });
});

/* ------------------------------------------------------------- checklist */

app.patch('/api/checklist/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM checklist_items WHERE id=?').get(req.params.id);
  if (!item) return fail(res, 'checklist item not found', 404);
  const body = req.body || {};
  const done = body.is_done === undefined ? item.is_done : (body.is_done ? 1 : 0);
  const task = body.task ?? item.task;
  const due = body.due_date === undefined ? item.due_date : (body.due_date || null);
  const priority = body.priority ?? item.priority;
  db.prepare('UPDATE checklist_items SET is_done=?, done_at=?, task=?, due_date=?, priority=? WHERE id=?')
    .run(done, done ? new Date().toISOString() : null, task, due, priority, item.id);
  if (item.is_done !== done) {
    logActivity(item.notice_id, done ? 'task.completed' : 'task.reopened', task);
  }
  return ok(res, db.prepare('SELECT * FROM checklist_items WHERE id=?').get(item.id));
});

app.post('/api/notices/:id/checklist', (req, res) => {
  const notice = db.prepare('SELECT id FROM notices WHERE id=?').get(req.params.id);
  if (!notice) return fail(res, 'notice not found', 404);
  const { task, due_date = null, priority = 'medium' } = req.body || {};
  if (!task) return fail(res, 'task is required');
  const max = db.prepare('SELECT COALESCE(MAX(sort_order),-1) m FROM checklist_items WHERE notice_id=?').get(notice.id).m;
  const info = db.prepare('INSERT INTO checklist_items (notice_id,task,due_date,priority,sort_order,source) VALUES (?,?,?,?,?,?)')
    .run(notice.id, task, due_date, priority, max + 1, 'manual');
  logActivity(notice.id, 'task.added', task);
  return ok(res, db.prepare('SELECT * FROM checklist_items WHERE id=?').get(info.lastInsertRowid), 201);
});

app.delete('/api/checklist/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM checklist_items WHERE id=?').get(req.params.id);
  if (!item) return fail(res, 'checklist item not found', 404);
  db.prepare('DELETE FROM checklist_items WHERE id=?').run(item.id);
  return ok(res, { deleted: Number(item.id) });
});

/* ------------------------------------------------- analysis without saving */

app.post('/api/analyze', (req, res) => {
  const text = (req.body?.text || '').trim();
  if (text.length < 20) return fail(res, 'text must be at least 20 characters');
  const result = analyze(text, { refDate: req.body?.ref_date });
  return ok(res, { ...result, saved: false });
});

/* -------------------------------------------------------------- errors */

app.use('/api', (req, res) => fail(res, `unknown endpoint: ${req.method} ${req.originalUrl}`, 404));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return fail(res, `File is too large. Maximum upload size is ${MAX_UPLOAD_MB} MB.`, 413);
  }
  console.error('[error]', err);
  return fail(res, err.message || 'internal server error', 500);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Notice2Action running on http://localhost:${PORT}`);
    console.log(`SQLite database: ${DB_PATH}`);
    console.log(`OCR available: ${ocrAvailable()}`);
  });
}

module.exports = { app };
