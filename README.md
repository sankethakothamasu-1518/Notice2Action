# Notice2Action

AI-powered web application that turns a long college notice into a **short summary**, **key details** (deadlines, eligibility, required documents) and an **action checklist** for students.

Built from `Notice2Action_Abstract_System_Flow.docx`. Implements every stage of the documented system flow:
input notice → text extraction → preprocessing → AI/NLP analysis → information extraction → summary & checklist → web display.

The original notice text is always stored and shown with the analysis, so extracted information can be **checked against the original** before acting on it.

---

## 1. Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | HTML + CSS + vanilla JS (single page, 6 views) | Zero build step, no framework install |
| Backend | Node.js 20+ / Express 4 | REST API, multipart uploads |
| Database | SQLite via the built-in `node:sqlite` driver | Real relational DB, **no native build step, no separate server** |
| NLP | Custom rule-based engine (`src/nlp.js`) | Runs fully offline: dates, eligibility, documents, extractive summariser |
| File ingestion | Custom PDF parser, DOCX reader, OCR adapter | No native/heavy dependencies |

No API keys and no internet access are required.

## 2. Run it

```bash
npm install       # express + multer only
npm run seed      # optional: 2 users + 3 realistic notices pushed through the pipeline
npm start         # http://localhost:3000
npm test          # 23 end-to-end API tests (boots the real server + real PDF/DOCX uploads)
npm run reset-db  # wipe data/ and start clean
```

Environment variables: `PORT` (default 3000), `N2A_DB` (db file path), `N2A_DATA_DIR` (data directory).

## 3. Database schema

`users`, `notices`, `key_points`, `deadlines`, `eligibility_criteria`, `required_documents`,
`checklist_items`, `activity_log`.

- `notices` holds the source text, main subject, summary, tags, word count, reading time, status and error message.
- Every derived table has `notice_id INTEGER ... REFERENCES notices(id) ON DELETE CASCADE`, so deleting a notice removes all of its extracted rows (verified by test).
- Allowed values are enforced with `CHECK` constraints (`role`, `status`, `priority`).
- Indexes on `status`, `due_date`, `is_done`, `notice_id`.

## 4. REST API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | service + DB health, OCR availability |
| GET | `/api/stats` | dashboard counters (notices, deadlines, due-soon, overdue, open/done tasks) |
| GET | `/api/notices?status=&q=&limit=&offset=&sort=` | list + search notices |
| GET | `/api/notices/:id` | full analysis of one notice |
| POST | `/api/notices` | create + analyse. Multipart field `file` **or** JSON `{text,title,uploaded_by,ref_date}` |
| POST | `/api/notices/:id/reanalyze` | re-run NLP on the stored text |
| PATCH | `/api/notices/:id` | rename |
| DELETE | `/api/notices/:id` | delete notice + all derived rows (cascade) |
| POST | `/api/notices/:id/checklist` | add a manual task |
| GET | `/api/deadlines?upcoming=true` | all deadlines with `days_left` |
| GET | `/api/checklist?status=open\|done&notice_id=` | checklist items |
| PATCH | `/api/checklist/:id` | tick / untick / edit a task |
| DELETE | `/api/checklist/:id` | delete a task |
| POST | `/api/analyze` | stateless analysis — nothing is saved |
| GET / POST | `/api/users` | list / create users |

Every response is `{success, data}` or `{success:false, error}`. Uploads > 12 MB return HTTP 413; unreadable files return 422 with a readable reason.

## 5. NLP pipeline (`src/nlp.js`)

1. **Preprocessing** — unicode normalisation, bullet/number-stripping, sentence segmentation, stopword removal, keyword + bigram extraction.
2. **AI/NLP analysis** — sentence scoring by keyword density, position and cue phrases; extractive summary (≤4 sentences) and main-subject detection.
3. **Information extraction** — regex cue models for deadlines, eligibility and documents; `extractDate()` resolves
   `2026-01-15`, `15 January 2026`, `January 15, 2026`, `15/01/2026`, `within 7 days`, `tomorrow`, `next Monday`
   against a reference date (needed for relative wording).
4. **Priority** — computed from days remaining vs. the reference date: ≤7 days → high, ≤21 → medium, else low.
5. **Checklist** — deadlines + instruction sentences + one "keep ready" item per required document, de-duplicated and sorted by priority/date.

## 6. Text extraction (`src/ingest.js`)

| Input | Method |
|---|---|
| PDF | built-in parser: locates streams, inflates `FlateDecode` with `zlib`, decodes `Tj`/`TJ`/`'`/`"` text operators |
| DOCX | minimal ZIP reader → `word/document.xml` → paragraph text |
| PNG/JPG/WEBP | OCR adapter that shells out to `tesseract` when installed; otherwise a clear 422 telling the user to paste text |
| TXT/MD | direct UTF-8 decode |

Scanned PDFs and images are reported honestly ("no selectable text… paste the notice text") instead of silently returning an empty summary.

## 7. Frontend

Single page, six tabbed views: **Dashboard** (8 live counters, upcoming deadlines, recent notices), **New notice**
(paste / upload / reference date / uploader, plus "Preview only (don't save)" and a sample loader),
**Notices** (search, status filter, inline full analysis, re-analyze, delete),
**Deadlines** (with days-left badges and an "upcoming only" toggle),
**Checklist** (progress bar, tick/untick persisted to the DB, delete), **API** (endpoint reference).

## 8. Verification

`npm test` boots the real server on a temporary database and runs 23 end-to-end tests: every endpoint, the
20-character validation, 404s, stateless analyse, cascade delete, relative-date resolution, corrupt-file handling,
and **real PDF and DOCX uploads built byte-by-byte in the test** to prove ingestion works.

```
23 passed, 0 failed
```
