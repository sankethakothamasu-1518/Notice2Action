'use strict';
/**
 * Database layer - SQLite via the built-in node:sqlite driver (no native build step).
 * Creates the schema on first run and exposes the shared connection.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.N2A_DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.N2A_DB || path.join(DATA_DIR, 'notice2action.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','staff','admin')),
  department    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  source_type   TEXT NOT NULL DEFAULT 'text',
  file_name     TEXT,
  raw_text      TEXT NOT NULL DEFAULT '',
  main_subject  TEXT,
  summary       TEXT,
  tags          TEXT DEFAULT '[]',
  word_count    INTEGER DEFAULT 0,
  reading_time_min INTEGER DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','analyzed','failed')),
  error_message TEXT,
  analysis_meta TEXT DEFAULT '[]',
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS key_points (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id  INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  point      TEXT NOT NULL,
  rank       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deadlines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id     INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  due_date      TEXT,
  due_date_text TEXT,
  priority      TEXT DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  snippet       TEXT
);

CREATE TABLE IF NOT EXISTS eligibility_criteria (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id  INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  criterion  TEXT NOT NULL,
  snippet    TEXT
);

CREATE TABLE IF NOT EXISTS required_documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id     INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  document_name TEXT NOT NULL,
  snippet       TEXT
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id    INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  task         TEXT NOT NULL,
  due_date     TEXT,
  priority     TEXT DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
  is_done      INTEGER NOT NULL DEFAULT 0,
  done_at      TEXT,
  sort_order   INTEGER DEFAULT 0,
  source       TEXT DEFAULT 'rule',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id  INTEGER REFERENCES notices(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notices_status  ON notices(status);
CREATE INDEX IF NOT EXISTS idx_deadlines_due   ON deadlines(due_date);
CREATE INDEX IF NOT EXISTS idx_checklist_done  ON checklist_items(is_done);
CREATE INDEX IF NOT EXISTS idx_kp_notice       ON key_points(notice_id);
`;

db.exec(SCHEMA);

function logActivity(noticeId, action, detail) {
  db.prepare('INSERT INTO activity_log (notice_id, action, detail) VALUES (?,?,?)')
    .run(noticeId === undefined ? null : noticeId, action, detail || null);
}

module.exports = { db, DB_PATH, logActivity };
