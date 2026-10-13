'use strict';
/**
 * Notice2Action rule-based NLP engine.
 * Pipeline stages: preprocess -> keywords -> summarise -> information extraction
 * (deadlines / eligibility / documents) -> action checklist.
 * Everything runs locally and deterministically: no external AI service required.
 */

const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by can cannot could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself let me more most my no nor not of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours
shall may must hereby henceforth kindly please note given whereas therefore however moreover also said such above-said herein therein vide along like using used upon within per etc
dear sir madam students student all college institution institute notice circular ref reference date no number regarding subject
`.split(/\s+/).filter(Boolean));

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12
};

const CUES = {
  deadline: /\b(deadline|dead\s*line|last\s+date|due\s+date|due\s+on|before|on\s+or\s+before|not\s+later\s+than|no\s+later\s+than|closing\s+date|submission\s+date|submit|submission|apply|register|registration|expires?|expiry|ends?|closes?|last\s+day)\b/i,
  eligibility: /\b(eligib\w*|criteria|criterion|who\s+can\s+apply|must\s+have|should\s+have|minimum|at\s+least|cgpa|gpa|percentage|marks|only\s+for|restricted\s+to|open\s+to|qualification|bonafide|attendance|requirement|background|prerequisite)\b/i,
  documents: /\b(document\w*|certificate\w*|marksheet\w*|mark\s+sheet\w*|transcript\w*|identity\s+card|id\s+card|id\s+proof|aadhaar\w*|passport\w*|photograph\w*|photo\w*|signature\w*|resume|cv|certificat\w*|bonafide|noc|receipt\w*|challan\w*|form\w*|attach\w*|enclose\w*|enclosure\w*|upload\w*|photocopy\w*|xerox\w*|undertaking|affidavit|passbook|admit\s+card|transfer\s+certificate|migration\s+certificate|income\s+certificate|caste\s+certificate|medical\s+certificate|domicile|self[-\s]?attested)\b/i,
  action: /\b(submit|register|apply|upload|pay|payment|deposit|collect|complete|fill|attend|report|carry|bring|contact|visit|verify|download|sign|renew|ensure|keep|submit|send|forward|appear|join|follow)\b/i
};

const DOC_PHRASES = [
  'marksheet', 'mark sheet', 'marks memo', 'consolidated marksheet', 'transcript', 'certificate',
  'bonafide certificate', 'transfer certificate', 'migration certificate', 'income certificate',
  'caste certificate', 'medical certificate', 'domicile certificate', 'conduct certificate',
  'aadhaar card', 'aadhaar', 'id card', 'identity card', 'college identity card', 'id proof',
  'passport size photograph', 'passport photograph', 'photograph', 'photo', 'signature',
  'resume', 'cv', 'noc', 'no objection certificate', 'fee receipt', 'receipt', 'challan',
  'bank passbook', 'passbook', 'admit card', 'hall ticket', 'undertaking', 'affidavit',
  'application form', 'registration form', 'form', 'self-attested copy', 'photocopy',
  'admit card', 'study certificate', 'category certificate', 'pwd certificate'
];

/* ------------------------------------------------------------------ utils */

function normalize(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2018\u2019\u201b]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sentences(text) {
  const out = [];
  const blocks = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  for (const block of blocks) {
    const cleaned = block
      .replace(/^\s*(?:[-*•·▪>]|\d{1,2}[.)]|[ivx]{1,4}[.)]|\([A-Za-z0-9]{1,3}\))\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;
    const parts = cleaned.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/);
    for (const p of parts) {
      const s = p.trim();
      if (s.length >= 12 && /[A-Za-z]/.test(s)) out.push(s);
    }
  }
  return out;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
}

function keywords(text, limit = 8) {
  const counts = new Map();
  const words = tokenize(text);
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
  // simple bigram boost so "hostel fee" style phrases surface
  for (let i = 0; i < words.length - 1; i++) {
    const bg = `${words[i]} ${words[i + 1]}`;
    counts.set(bg, (counts.get(bg) || 0) + 1.5);
  }
  return [...counts.entries()]
    .filter(([w, c]) => c > 1 || !w.includes(' '))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, score]) => ({ word, score: Math.round(score * 100) / 100 }));
}

function truncate(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1).replace(/[\s,;:-]+$/, '')}…`;
}

function titleCase(s) {
  return String(s).split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/* ------------------------------------------------------------------ dates */

function iso(y, m, d) {
  const yy = Number(y), mm = Number(m), dd = Number(d);
  if (!yy || !mm || !dd || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  if (dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) return null;
  return dt.toISOString().slice(0, 10);
}

function addDays(refISO, days) {
  const d = new Date(`${refISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Find the most specific date expression in a sentence and resolve it to an ISO date.
 * Handles: 2026-01-15 | 15 January 2026 | January 15, 2026 | 15/01/2026 | 15-01-26
 *          within 7 days | tomorrow | next Monday
 */
function extractDate(sentence, refDateISO) {
  const ref = refDateISO || new Date().toISOString().slice(0, 10);
  const s = String(sentence || '');
  const monthNames = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const v = iso(m[1], m[2], m[3]);
    if (v) return { date: v, text: m[0] };
  }

  const dmy = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s*)?(?:-|\\s)?\\s*(${monthNames})[a-z]*\\.?\\s*,?\\s*(\\d{4})?\\b`, 'i');
  m = s.match(dmy);
  if (m) {
    const year = m[3] || ref.slice(0, 4);
    const v = iso(year, MONTHS[m[2].toLowerCase()], m[1]);
    if (v) return { date: v, text: m[0].trim(), assumedYear: !m[3] };
  }

  const mdy = new RegExp(
    `\\b(${monthNames})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})?\\b`, 'i');
  m = s.match(mdy);
  if (m) {
    const year = m[3] || ref.slice(0, 4);
    const v = iso(year, MONTHS[m[1].toLowerCase()], m[2]);
    if (v) return { date: v, text: m[0].trim(), assumedYear: !m[3] };
  }

  m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    let year = m[3].length === 2 ? `20${m[3]}` : m[3];
    let first = Number(m[1]), second = Number(m[2]);
    let day, month;
    if (first > 12 && second <= 12) { day = first; month = second; }
    else if (second > 12 && first <= 12) { month = first; day = second; }
    else { day = first; month = second; } // default day-first
    const v = iso(year, month, day);
    if (v) return { date: v, text: m[0] };
  }

  m = s.match(/\bwithin\s+(\d{1,3})\s*(day|days|week|weeks|month|months)\b/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const days = unit.startsWith('day') ? n : unit.startsWith('week') ? n * 7 : n * 30;
    return { date: addDays(ref, days), text: m[0], relative: true };
  }

  if (/\btomorrow\b/i.test(s)) return { date: addDays(ref, 1), text: 'tomorrow', relative: true };
  if (/\btoday\b/i.test(s)) return { date: ref, text: 'today', relative: true };

  m = s.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)\b/i);
  if (m) {
    const word = m[1].toLowerCase();
    if (word === 'week') return { date: addDays(ref, 7), text: m[0], relative: true };
    if (word === 'month') return { date: addDays(ref, 30), text: m[0], relative: true };
    const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const target = names.indexOf(word);
    const cur = new Date(`${ref}T00:00:00Z`).getUTCDay();
    let delta = (target - cur + 7) % 7;
    if (delta === 0) delta = 7;
    return { date: addDays(ref, delta), text: m[0], relative: true };
  }

  return null;
}

function daysBetween(isoA, isoB) {
  const a = Date.UTC(...isoA.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const b = Date.UTC(...isoB.split('-').map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((a - b) / 86400000);
}

function priorityFor(dueISO, refISO) {
  if (!dueISO) return 'medium';
  const d = daysBetween(dueISO, refISO);
  if (d < 0) return 'high';
  if (d <= 7) return 'high';
  if (d <= 21) return 'medium';
  return 'low';
}


/* Strip boilerplate lead-ins so extracted labels read like tasks, not sentences. */
const LEAD_INS = [
  /^(?:all\s+)?(?:hostel\s+residents|students|candidates|applicants|residents|participants)\s+(?:are\s+)?(?:hereby\s+)?(?:informed|notified|advised|requested|directed|instructed)\s+(?:that\s+)?/i,
  /^(?:it\s+is\s+)?(?:hereby\s+)?(?:notified|informed|announced)\s+(?:that\s+)?/i,
  /^(?:all\s+students|candidates|applicants)\s+(?:must|should|shall|are\s+required\s+to)\s+/i,
  /^(?:please\s+)?(?:note\s+)?that\s+/i,
  /^(?:the\s+)?(?:students?|candidates?|applicants?)\s+(?:who\s+)?/i
];
function stripLeadIn(text) {
  let out = String(text || '').trim();
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const re of LEAD_INS) {
      const next = out.replace(re, '');
      if (next !== out) { out = next.trim(); changed = true; }
    }
    if (!changed) break;
  }
  out = out.replace(/^(?:are|is|were|be)\s+/i, '').replace(/\s+/g, ' ').trim();
  return out.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/* --------------------------------------------------------------- analysis */

function scoreSentences(sents, kw) {
  const kwMap = new Map(kw.map((k, i) => [k.word, k.score * (1 - i * 0.04)]));
  const max = Math.max(1, ...[...kwMap.values()]);
  return sents.map((s, i) => {
    const toks = tokenize(s);
    let score = 0;
    for (const t of toks) if (kwMap.has(t)) score += kwMap.get(t) / max;
    score = score / Math.sqrt(Math.max(4, toks.length));
    const posBonus = i === 0 ? 0.55 : i < 3 ? 0.3 : i < 8 ? 0.12 : 0;
    let cueBonus = 0;
    if (CUES.deadline.test(s)) cueBonus += 0.35;
    if (CUES.eligibility.test(s)) cueBonus += 0.22;
    if (CUES.documents.test(s)) cueBonus += 0.15;
    if (/\d/.test(s)) cueBonus += 0.08;
    return { i, s, score: score + posBonus + cueBonus };
  });
}

function buildSummary(scored, budget = 520, maxSentences = 4) {
  const picked = [];
  let len = 0;
  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    if (picked.length >= maxSentences) break;
    if (len + item.s.length > budget && picked.length >= 1) continue;
    picked.push(item);
    len += item.s.length + 1;
  }
  return picked.sort((a, b) => a.i - b.i).map((p) => p.s).join(' ');
}

function buildKeyPoints(scored, summary, limit = 6) {
  const summaryText = summary.toLowerCase();
  const out = [];
  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    if (summaryText.includes(item.s.toLowerCase().slice(0, 60))) continue;
    const point = truncate(item.s, 170);
    if (out.some((o) => o.toLowerCase().slice(0, 45) === point.toLowerCase().slice(0, 45))) continue;
    out.push(point);
    if (out.length >= limit) break;
  }
  return out;
}

function mainSubject(text, sentencesList, kw) {
  const firstBlock = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)[0] || '';
  const looksLikeHeading = firstBlock.length > 8 && firstBlock.length <= 95 && !/[.!?]$/.test(firstBlock) &&
    !/^(notice|circular|date|ref|to|from|dear)\b/i.test(firstBlock);
  if (looksLikeHeading) return truncate(firstBlock.replace(/^[#*\s]+/, ''), 95);
  const first = sentencesList[0];
  if (first && first.length <= 130) return truncate(first, 130);
  const top = kw.slice(0, 3).map((k) => k.word);
  return top.length ? `Notice concerning ${top.join(', ')}` : 'College notice';
}

function detectDeadlines(sents, refISO) {
  const rows = [];
  for (const s of sents) {
    if (!CUES.deadline.test(s)) continue;
    if (!/\b(submit|submission|apply|application|register|registration|pay|payment|deposit|due|deadline|last\s+date|before|closing|fee|upload|report|collect|verify|complete|expires?|ends?|close)\b/i.test(s)) continue;
    const found = extractDate(s, refISO);
    const label = truncate(stripLeadIn(s.replace(/^\s*(?:please|kindly)\s+/i, '')), 130);
    rows.push({
      label,
      due_date: found ? found.date : null,
      due_date_text: found ? found.text : 'as stated in notice',
      priority: priorityFor(found && found.date, refISO),
      snippet: truncate(s, 280)
    });
  }
  // de-duplicate on label+date
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.label.slice(0, 45).toLowerCase()}|${r.due_date || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 8);
}

function detectEligibility(sents) {
  const out = [];
  for (const s of sents) {
    if (!CUES.eligibility.test(s)) continue;
    if (/document|certificate|marksheet|attach|upload/i.test(s) && !/eligib|cgpa|gpa|minimum|at least|percentage|attendance|only for|must have/i.test(s)) continue;
    const criterion = truncate(s, 220);
    if (out.some((o) => o.criterion.toLowerCase().slice(0, 40) === criterion.toLowerCase().slice(0, 40))) continue;
    out.push({ criterion, snippet: truncate(s, 280) });
    if (out.length >= 7) break;
  }
  return out;
}

function detectDocuments(sents) {
  const found = new Map();
  for (const s of sents) {
    if (!CUES.documents.test(s)) continue;
    for (const phrase of DOC_PHRASES) {
      const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`, 'i');
      if (re.test(s) && !found.has(phrase)) {
        found.set(phrase, { phrase, document_name: titleCase(phrase), snippet: truncate(s, 280) });
      }
    }
  }
  // drop generic phrases when a more specific phrase that contains them also matched
  const phrases = [...found.keys()];
  const keep = phrases.filter((p) => !phrases.some((q) => q !== p && q.length > p.length &&
    new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'i').test(q)));
  const generic = new Set(['form', 'photo', 'photograph', 'certificate', 'document']);
  const pruned = keep.filter((p) => !(generic.has(p) && keep.some((q) => q !== p && q.length > p.length)));
  return pruned.slice(0, 10).map((p) => ({ document_name: found.get(p).document_name, snippet: found.get(p).snippet }));
}

function detectActions(sents, refISO) {
  const out = [];
  const imperative = /^(?:all\s+students\s+(?:are\s+(?:hereby\s+)?(?:directed|informed|requested|advised)\s+to|must|should|shall)|students\s+(?:must|should|shall)|please|kindly|candidates\s+(?:must|are\s+required\s+to)|applicants\s+(?:must|are\s+required\s+to)|those\s+who)\s+/i;
  for (const s of sents) {
    const startsWithVerb = /^(submit|register|apply|upload|pay|deposit|collect|complete|fill|attend|report|carry|bring|contact|visit|verify|download|sign|renew|ensure|keep|send|forward|appear|join|note)\b/i.test(s);
    if (!startsWithVerb && !imperative.test(s)) continue;
    if (!CUES.action.test(s)) continue;
    let task = s
      .replace(imperative, '')
      .replace(/^(?:are|is)\s+(?:required|requested|directed|advised|informed)\s+to\s+/i, '')
      .replace(/^to\s+/i, '')
      .trim();
    task = truncate(stripLeadIn(task), 150);
    const found = extractDate(s, refISO);
    out.push({
      task,
      due_date: found ? found.date : null,
      priority: priorityFor(found && found.date, refISO),
      snippet: truncate(s, 280),
      source: 'instruction'
    });
  }
  return out;
}

function buildChecklist(deadlines, actions, documents) {
  const items = [];
  const seen = new Set();
  const push = (item) => {
    const key = item.task.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 55);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  for (const d of deadlines) {
    push({ task: d.label, due_date: d.due_date, priority: d.priority, source: 'deadline' });
  }
  for (const a of actions) push(a);
  for (const doc of documents) {
    push({
      task: `Keep ready: ${doc.document_name}`,
      due_date: null,
      priority: 'medium',
      source: 'document'
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return items
    .sort((a, b) => rank[a.priority] - rank[b.priority] || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')))
    .map((it, i) => ({ ...it, sort_order: i }));
}

/**
 * Full analysis of a notice.
 * @param {string} text raw notice text
 * @param {{refDate?:string}} [opts]
 */
function analyze(text, opts = {}) {
  const refDate = opts.refDate || new Date().toISOString().slice(0, 10);
  const raw = String(text || '');
  const clean = normalize(raw);
  const sents = sentences(clean);
  const kw = keywords(clean, 10);
  const scored = scoreSentences(sents, kw);
  const summary = buildSummary(scored);
  const subjects = mainSubject(clean, sents, kw);
  const deadlines = detectDeadlines(sents, refDate);
  const eligibility = detectEligibility(sents);
  const documents = detectDocuments(sents);
  const actions = detectActions(sents, refDate);
  const checklist = buildChecklist(deadlines, actions, documents);
  const words = clean.split(/\s+/).filter(Boolean).length;

  const keyPoints = buildKeyPoints(scored, summary, 6);
  if (deadlines[0] && deadlines[0].due_date) {
    keyPoints.unshift(`Key deadline: ${truncate(deadlines[0].label, 110)} (${deadlines[0].due_date})`);
  }
  if (documents.length) {
    keyPoints.push(`Required documents: ${documents.map((d) => d.document_name).join(', ')}`);
  }
  if (eligibility.length) {
    keyPoints.push(`Eligibility: ${truncate(eligibility[0].criterion, 140)}`);
  }

  return {
    refDate,
    main_subject: subjects,
    summary: summary || truncate(clean, 400),
    key_points: [...new Set(keyPoints)].slice(0, 7),
    deadlines,
    eligibility,
    required_documents: documents,
    actions,
    checklist,
    tags: kw.slice(0, 6).map((k) => k.word),
    stats: {
      characters: clean.length,
      words,
      sentences: sents.length,
      reading_time_min: Math.max(1, Math.round(words / 200))
    }
  };
}

module.exports = {
  analyze, normalize, sentences, keywords, extractDate, priorityFor, daysBetween,
  truncate, stripLeadIn, CUES, DOC_PHRASES
};
