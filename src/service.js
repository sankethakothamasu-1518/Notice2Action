'use strict';
/** Shared service helper so both the API and the seeder write identical rows. */
const { db } = require('./db');

function persistAnalysis(noticeId, result) {
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
      result.stats.reading_time_min,
      JSON.stringify([{ ref_date: result.refDate, stats: result.stats, engine: 'rule-based NLP v1' }]), noticeId);
}

module.exports = { persistAnalysis };
