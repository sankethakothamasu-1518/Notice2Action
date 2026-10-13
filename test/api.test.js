'use strict';
/**
 * End-to-end API tests. Boots the server on a throwaway SQLite file and
 * exercises every endpoint, including real PDF / DOCX upload ingestion.
 * Run: node test/api.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'n2a-test-'));
process.env.N2A_DATA_DIR = TMP;
process.env.PORT = String(PORT);

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); pass++; results.push(`  PASS  ${name}`); }
  catch (e) { fail++; results.push(`  FAIL  ${name}\n        ${e.message}`); }
}
async function req(method, url, body, isForm) {
  const opts = { method };
  if (body && !isForm) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
  if (body && isForm) opts.body = body;
  const res = await fetch(BASE + url, opts);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- build a tiny valid PDF and DOCX in memory so ingestion is really exercised --- */
function makePdf(lines) {
  const content = `BT /F1 11 Tf 40 780 Td 14 TL\n` +
    lines.map((l) => `(${l.replace(/[()\\]/g, '')}) Tj T*`).join('\n') + `\nET`;
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>';
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i <= 5; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function makeDocx(paragraphs) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</w:t></w:r></w:p>`).join('\n')}
</w:body></w:document>`;
  const files = { 'word/document.xml': Buffer.from(xml, 'utf8') };
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    let crc = 0 ^ -1;
    for (const b of data) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 0xff];
    crc = (crc ^ -1) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8); cen.writeUInt16LE(8, 10); cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

const NOTICE_TEXT = `SCHOLARSHIP NOTICE 2026
Applications are invited for the merit scholarship. The last date for submission of the application is 5 November 2026.
Eligibility criteria: the applicant must have a minimum CGPA of 7.5 and family income must not exceed INR 800000.
Required documents: income certificate, previous year mark sheet and a bonafide certificate.
All students must submit the application form at the scholarship cell before the deadline.`;

(async function run() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, N2A_DATA_DIR: TMP, PORT: String(PORT), N2A_DB: path.join(TMP, 'test.db') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await wait(1200);

  const HEALTH = await req('GET', '/api/health');
  if (HEALTH.status !== 200) { console.error('Server did not start:', HEALTH.text); process.exit(1); }

  await test('GET /api/health reports up + database', () => {
    assert.equal(HEALTH.json.data.status, 'up');
    assert.ok(HEALTH.json.data.database);
  });

  await test('GET /api/stats on an empty database returns zeros', async () => {
    const r = await req('GET', '/api/stats');
    assert.equal(r.json.data.notices, 0);
  });

  await test('POST /api/users creates a user; duplicate email is rejected', async () => {
    const a = await req('POST', '/api/users', { name: 'Test Student', email: 'test@college.edu' });
    assert.equal(a.status, 201);
    const b = await req('POST', '/api/users', { name: 'Dup', email: 'test@college.edu' });
    assert.equal(b.status, 400);
  });

  let created;
  await test('POST /api/notices (JSON text) creates + analyses a notice', async () => {
    const r = await req('POST', '/api/notices', { title: 'Scholarship Notice 2026', text: NOTICE_TEXT, ref_date: '2026-10-12' });
    assert.equal(r.status, 201, r.text.slice(0, 200));
    created = r.json.data;
    assert.equal(created.status, 'analyzed');
    assert.ok(created.summary.length > 40, 'summary too short');
    assert.ok(created.key_points.length > 0, 'no key points');
    assert.ok(created.checklist.length > 0, 'no checklist items');
  });

  await test('deadline date is resolved to ISO 2026-11-05', () => {
    const hit = created.deadlines.find((d) => d.due_date === '2026-11-05');
    assert.ok(hit, `expected 2026-11-05, got ${JSON.stringify(created.deadlines.map((d) => d.due_date))}`);
  });

  await test('documents + eligibility detected', () => {
    const docs = created.required_documents.map((d) => d.document_name.toLowerCase()).join('|');
    assert.ok(/income certificate/.test(docs), `docs: ${docs}`);
    assert.ok(created.eligibility.length > 0, 'no eligibility rows');
  });

  await test('POST /api/analyze is stateless (nothing persisted)', async () => {
    const before = (await req('GET', '/api/stats')).json.data.notices;
    const r = await req('POST', '/api/analyze', { text: NOTICE_TEXT, ref_date: '2026-10-12' });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.saved, false);
    const after = (await req('GET', '/api/stats')).json.data.notices;
    assert.equal(before, after);
  });

  await test('POST /api/notices rejects text shorter than 20 chars', async () => {
    const r = await req('POST', '/api/notices', { text: 'too short' });
    assert.equal(r.status, 400);
  });

  await test('GET /api/notices list + search works', async () => {
    const all = await req('GET', '/api/notices');
    assert.ok(all.json.data.total >= 1);
    const hit = await req('GET', '/api/notices?q=scholarship');
    assert.ok(hit.json.data.items.length >= 1);
    const miss = await req('GET', '/api/notices?q=zzzznope');
    assert.equal(miss.json.data.items.length, 0);
  });

  await test('GET /api/notices/:id returns the full analysis', async () => {
    const r = await req('GET', `/api/notices/${created.id}`);
    assert.equal(r.json.data.id, created.id);
    for (const k of ['summary', 'key_points', 'deadlines', 'eligibility', 'required_documents', 'checklist', 'raw_text']) {
      assert.ok(k in r.json.data, `missing ${k}`);
    }
    assert.ok(r.json.data.raw_text.includes('SCHOLARSHIP NOTICE'));
  });

  await test('GET /api/notices/99999 -> 404', async () => {
    const r = await req('GET', '/api/notices/99999');
    assert.equal(r.status, 404);
  });

  await test('PATCH /api/notices/:id renames', async () => {
    const r = await req('PATCH', `/api/notices/${created.id}`, { title: 'Renamed Scholarship Notice' });
    assert.equal(r.json.data.title, 'Renamed Scholarship Notice');
  });

  await test('POST /api/notices/:id/reanalyze repopulates derived tables', async () => {
    const r = await req('POST', `/api/notices/${created.id}/reanalyze`, { ref_date: '2026-10-12' });
    assert.equal(r.status, 200);
    assert.ok(r.json.data.checklist.length > 0);
  });

  await test('PDF upload is parsed (FlateDecode) and analysed', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([makePdf(['Hostel Fee Notice', 'The last date for payment is 25 October 2026.', 'Students must submit the fee receipt at the warden office.', 'Required documents: college identity card and a passport size photograph.'])], { type: 'application/pdf' }), 'notice.pdf');
    fd.append('ref_date', '2026-10-12');
    const r = await req('POST', '/api/notices', fd, true);
    assert.equal(r.status, 201, r.text.slice(0, 300));
    assert.equal(r.json.data.source_type, 'pdf');
    assert.ok(r.json.data.raw_text.includes('Hostel Fee Notice'));
    assert.ok(r.json.data.deadlines.some((d) => d.due_date === '2026-10-25'), JSON.stringify(r.json.data.deadlines));
  });

  await test('DOCX upload is parsed (word/document.xml) and analysed', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([makeDocx([
      'MERIT SCHOLARSHIP APPLICATION',
      'The last date for submission of the application is 5 November 2026.',
      'Eligibility: minimum CGPA of 7.5 and annual family income below INR 800000.',
      'Documents to be uploaded: income certificate, mark sheet, bonafide certificate.'
    ])], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'scholarship.docx');
    fd.append('ref_date', '2026-10-12');
    const r = await req('POST', '/api/notices', fd, true);
    assert.equal(r.status, 201, r.text.slice(0, 300));
    assert.equal(r.json.data.source_type, 'docx');
    assert.ok(r.json.data.raw_text.includes('MERIT SCHOLARSHIP APPLICATION'));
    assert.ok(r.json.data.deadlines.some((d) => d.due_date === '2026-11-05'), JSON.stringify(r.json.data.deadlines));
  });

  await test('unsupported/corrupt file fails gracefully with 422', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('not really a pdf')], { type: 'application/pdf' }), 'broken.pdf');
    const r = await req('POST', '/api/notices', fd, true);
    assert.equal(r.status, 422);
    assert.ok(/error/.test(r.text));
  });

  await test('relative dates resolve against ref_date (within 7 days)', async () => {
    const r = await req('POST', '/api/analyze', {
      text: 'All students must submit the room allotment slip to the hostel office within 7 days of the allotment date.',
      ref_date: '2026-10-12'
    });
    assert.equal(r.status, 200);
    const d = r.json.data.deadlines[0];
    assert.ok(d && d.due_date === '2026-10-19', JSON.stringify(r.json.data.deadlines));
  });

  await test('GET /api/deadlines aggregates across notices with days_left', async () => {
    const r = await req('GET', '/api/deadlines');
    assert.ok(r.json.data.count >= 2);
    assert.ok(r.json.data.items.every((d) => 'notice_title' in d));
    const up = await req('GET', '/api/deadlines?upcoming=true');
    assert.ok(up.json.data.items.every((d) => d.due_date >= '2026-01-01'));
  });

  await test('checklist: list, tick, untick, add manual, delete', async () => {
    const list = await req('GET', `/api/checklist?notice_id=${created.id}`);
    assert.ok(list.json.data.items.length > 0);
    const item = list.json.data.items[0];
    const done = await req('PATCH', `/api/checklist/${item.id}`, { is_done: true });
    assert.equal(done.json.data.is_done, 1);
    assert.ok(done.json.data.done_at);
    const undone = await req('PATCH', `/api/checklist/${item.id}`, { is_done: false });
    assert.equal(undone.json.data.is_done, 0);
    const added = await req('POST', `/api/notices/${created.id}/checklist`, { task: 'Collect hall ticket', due_date: '2026-11-20', priority: 'high' });
    assert.equal(added.status, 201);
    const del = await req('DELETE', `/api/checklist/${added.json.data.id}`);
    assert.equal(del.json.data.deleted, added.json.data.id);
  });

  await test('GET /api/checklist?status=open|done filters correctly', async () => {
    const open = await req('GET', '/api/checklist?status=open');
    assert.ok(open.json.data.items.every((i) => i.is_done === 0));
    const done = await req('GET', '/api/checklist?status=done');
    assert.ok(done.json.data.items.every((i) => i.is_done === 1));
  });

  await test('stats reflect created content', async () => {
    const r = await req('GET', '/api/stats');
    assert.ok(r.json.data.notices >= 3, `notices=${r.json.data.notices}`);
    assert.ok(r.json.data.deadlines >= 3);
    assert.ok(r.json.data.open_tasks >= 1);
  });

  await test('unknown /api route returns JSON 404', async () => {
    const r = await req('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.success, false);
  });

  await test('DELETE /api/notices/:id cascades all child rows', async () => {
    const r = await req('DELETE', `/api/notices/${created.id}`);
    assert.equal(r.status, 200);
    const gone = await req('GET', `/api/notices/${created.id}`);
    assert.equal(gone.status, 404);
    const cl = await req('GET', `/api/checklist?notice_id=${created.id}`);
    assert.equal(cl.json.data.items.length, 0);
  });

  server.kill();
  console.log('\nNotice2Action API test suite');
  console.log('='.repeat(52));
  console.log(results.join('\n'));
  console.log('='.repeat(52));
  console.log(`${pass} passed, ${fail} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
