'use strict';
/**
 * Demo seed data: two users, three real-world-shaped college notices
 * (hostel, scholarship, exam) pushed through the NLP pipeline.
 * Run: node src/seed.js   (skips seeding when notices already exist)
 */
const { db, logActivity } = require('./db');
const { analyze } = require('./nlp');
const { persistAnalysis } = require('./service');

const REF = '2026-10-12';

const USERS = [
  ['Ananya Sharma', 'ananya.sharma@college.edu', 'student', 'Computer Science'],
  ['Dr. Ravi Menon', 'office.academics@college.edu', 'staff', 'Academic Office']
];

const NOTICES = [
  {
    title: 'Hostel Fee Payment and Room Allotment - Odd Semester 2026-27',
    refDate: REF,
    text: `HOSTEL FEE PAYMENT AND ROOM ALLOTMENT - ODD SEMESTER 2026-27
Office of the Chief Warden, Sunrise Institute of Technology

All hostel residents are hereby informed that the hostel fee for the odd semester 2026-27 must be paid before 25 October 2026. The fee can be paid online through the student portal or at the accounts counter between 10:00 AM and 3:00 PM on working days.

Students who fail to remit the fee on or before the last date will not be allotted a room for the odd semester. Room allotment will be carried out on 30 October 2026 and the allotment list will be displayed on the hostel notice board.

Eligibility for continued hostel accommodation: students must have a minimum attendance of 75 percent in the previous semester and no pending disciplinary case. Only bonafide students of the institute are eligible to apply.

Required documents to be submitted at the warden office along with the fee receipt: a photocopy of the college identity card, one passport size photograph, and the previous semester mark sheet.

Please collect the room allotment slip from the warden office within 7 days of the allotment date, otherwise the allotment will be treated as cancelled.

For any clarification contact the hostel office at hostel.office@college.edu.`,
    uploaded_by: 1
  },
  {
    title: 'Merit-cum-Means Scholarship 2026 - Application Guidelines',
    refDate: REF,
    text: `MERIT-CUM-MEANS SCHOLARSHIP 2026 - APPLICATION GUIDELINES
Scholarship and Financial Aid Cell

Applications are invited from eligible students for the Merit-cum-Means Scholarship 2026. The last date for submission of the online application is 5 November 2026. Late applications will not be accepted.

Eligibility criteria: the applicant must be a regular student of the second or third year, must have secured a minimum CGPA of 7.5 in the previous academic year, and the annual family income of the applicant must not exceed INR 8,00,000. Students who are receiving any other government scholarship are not eligible to apply.

Documents to be uploaded with the application form: income certificate issued within the last six months, self-attested copies of the previous year mark sheets, a bonafide certificate from the department, and a bank passbook copy of the applicant.

Shortlisted candidates must attend the verification interview on 18 November 2026 at the administrative block. Candidates should carry original certificates for verification.

Please note that the scholarship amount will be credited directly to the student bank account after the verification process is completed. Any discrepancy in the submitted documents will lead to cancellation of the scholarship.

For further details visit the scholarship cell or write to scholarship@college.edu.`,
    uploaded_by: 2
  },
  {
    title: 'Revised Schedule for End Semester Examinations and Hall Ticket Download',
    refDate: REF,
    text: `REVISED SCHEDULE FOR END SEMESTER EXAMINATIONS
Examination Section

The revised schedule for the end semester examinations of November 2026 is hereby notified. Theory examinations will commence on 24 November 2026 and practical examinations will conclude on 12 December 2026.

All students must download the hall ticket from the examination portal before 20 November 2026. Students who have not cleared the pending fee dues will not be permitted to download the hall ticket.

Eligibility to appear for the examination: a minimum of 75 percent attendance in each subject and no pending fee arrears as on 15 November 2026. Students with attendance below the prescribed limit must submit a condonation request to the head of the department on or before 14 November 2026.

Students are required to carry the hall ticket and the college identity card to every examination hall. Mobile phones and smart watches are strictly prohibited inside the examination hall.

Any request for revaluation must be submitted within 10 days of the declaration of results along with the prescribed fee.

For examination related queries contact the examination section at exams@college.edu.`,
    uploaded_by: 2
  }
];

function seed() {
  for (const [name, email, role, department] of USERS) {
    const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (!exists) db.prepare('INSERT INTO users (name,email,role,department) VALUES (?,?,?,?)').run(name, email, role, department);
  }
  const userRows = db.prepare('SELECT id FROM users ORDER BY id').all();
  const userIds = userRows.map((r) => r.id);

  const already = db.prepare('SELECT COUNT(*) c FROM notices').get().c;
  if (already > 0) {
    console.log(`Seed skipped: ${already} notice(s) already present.`);
    return;
  }

  for (const n of NOTICES) {
    const uploadedBy = n.uploaded_by ?? userIds[0];
    const info = db.prepare(`INSERT INTO notices (title,source_type,file_name,raw_text,uploaded_by,status)
      VALUES (?,?,?,?,?,'processing')`).run(n.title, 'text', null, n.text, uploadedBy);
    const id = Number(info.lastInsertRowid);
    const result = analyze(n.text, { refDate: n.refDate });
    persistAnalysis(id, result);
    logActivity(id, 'notice.seeded', `${result.deadlines.length} deadline(s), ${result.checklist.length} task(s)`);
    console.log(`Seeded notice #${id}: ${n.title} -> ${result.deadlines.length} deadlines, ${result.checklist.length} tasks`);
  }

  // mark a couple of tasks done so the dashboard shows progress
  const done = db.prepare("SELECT id FROM checklist_items WHERE notice_id=(SELECT MIN(id) FROM notices) ORDER BY sort_order LIMIT 1").all();
  for (const d of done) {
    db.prepare("UPDATE checklist_items SET is_done=1, done_at=datetime('now') WHERE id=?").run(d.id);
  }
  console.log('Seed complete.');
}

if (require.main === module) seed();

module.exports = { seed, REF, NOTICES, USERS };
