'use strict';
/**
 * Text extraction layer.
 *  - text / txt / md  : decoded directly
 *  - pdf              : built-in stream parser + FlateDecode (zlib), no native deps
 *  - docx             : minimal ZIP reader -> word/document.xml -> plain text
 *  - image (png/jpg)  : OCR adapter (uses the `tesseract` CLI when it is installed)
 * Everything falls back gracefully and reports why extraction failed.
 */
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

/* ------------------------------------------------------------------- pdf */

function inflateMaybe(buf) {
  try { return zlib.inflateSync(buf); } catch (_) {}
  try { return zlib.inflateRawSync(buf); } catch (_) {}
  return null;
}

function decodePdfString(raw) {
  return raw
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, '\n').replace(/\\r/g, ' ').replace(/\\t/g, ' ')
    .replace(/\\([()\\])/g, '$1');
}

function decodeHexString(hex) {
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i < cleaned.length; i += 2) {
    const code = parseInt(cleaned.slice(i, i + 2), 16);
    if (code >= 32 && code < 127) out += String.fromCharCode(code);
    else if (code === 10 || code === 13) out += ' ';
  }
  return out;
}

function textFromContentStream(content) {
  let out = '';
  const tokens = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>|\bT[JjdD*]\b|\bET\b|\bBT\b|\bTJ\b|\bTD\b|\bTd\b|\bT\*\b/g;
  let m;
  while ((m = tokens.exec(content)) !== null) {
    const tok = m[0];
    if (tok.startsWith('(')) out += decodePdfString(tok.slice(1, -1));
    else if (tok.startsWith('<')) out += decodeHexString(tok.slice(1, -1));
    else if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok === 'ET') out += '\n';
    else if (tok === 'TJ' || tok === 'Tj') out += ' ';
  }
  return out;
}

function extractPdf(buffer) {
  const latin = buffer.toString('latin1');
  const chunks = [];
  const re = /stream\r\n|stream\n|stream\r/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    let raw = buffer.subarray(start, end);
    // strip a single trailing EOL
    if (raw.length && raw[raw.length - 1] === 0x0a) raw = raw.subarray(0, raw.length - 1);
    if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
    const dict = latin.slice(Math.max(0, m.index - 400), m.index);
    let text = null;
    if (/FlateDecode/.test(dict)) {
      const un = inflateMaybe(raw);
      if (un) text = un.toString('latin1');
    } else {
      text = raw.toString('latin1');
    }
    if (text && /\bT[Jj]\b|\bTJ\b/.test(text)) chunks.push(textFromContentStream(text));
    re.lastIndex = end;
  }
  const text = chunks.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) {
    throw new Error('No selectable text found in this PDF (it may be a scanned image). Paste the notice text or upload an image for OCR.');
  }
  return text;
}

/* ------------------------------------------------------------------ docx */

function unzipEntry(buffer, wanted) {
  let offset = 0;
  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    if (compSize === 0) break; // streaming entry - not supported, stop scanning
    const data = buffer.subarray(dataStart, dataStart + compSize);
    if (name === wanted) {
      if (method === 0) return data.toString('utf8');
      if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
      throw new Error(`Unsupported compression method ${method} inside DOCX`);
    }
    offset = dataStart + compSize;
  }
  return null;
}

function extractDocx(buffer) {
  const xml = unzipEntry(buffer, 'word/document.xml');
  if (!xml) throw new Error('Could not read word/document.xml from the DOCX file.');
  const withBreaks = xml
    .replace(/<w:tab\b[^>]*\/>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\b[^>]*\/>/g, '\n');
  const text = withBreaks
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------- ocr */

function ocrAvailable() {
  try {
    execFileSync('which', ['tesseract'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function ocrImage(buffer, fileName) {
  return new Promise((resolve, reject) => {
    if (!ocrAvailable()) {
      return reject(new Error('OCR engine (tesseract) is not installed on this server. Paste the notice text instead, or upload a text-based PDF/DOCX.'));
    }
    const ext = path.extname(fileName || '') || '.png';
    const base = path.join(os.tmpdir(), `n2a-ocr-${Date.now()}`);
    const img = `${base}${ext}`;
    fs.writeFileSync(img, buffer);
    execFile('tesseract', [img, base, '-l', 'eng'], { maxBuffer: 8 * 1024 * 1024 }, (err) => {
      try {
        if (err) throw new Error(`OCR failed: ${err.message}`);
        const txt = fs.readFileSync(`${base}.txt`, 'utf8');
        if (!txt.trim()) throw new Error('OCR produced no text - the image may be too low quality.');
        resolve(txt);
      } catch (e) {
        reject(e);
      } finally {
        for (const f of [img, `${base}.txt`]) { try { fs.unlinkSync(f); } catch (_) {} }
      }
    });
  });
}

/* -------------------------------------------------------------- dispatch */

function detectSource(fileName, mime) {
  const name = String(fileName || '').toLowerCase();
  const m = String(mime || '').toLowerCase();
  if (name.endsWith('.pdf') || m.includes('pdf')) return 'pdf';
  if (name.endsWith('.docx') || m.includes('wordprocessingml')) return 'docx';
  if (/\.(png|jpe?g|webp|bmp|tiff?|gif)$/.test(name) || m.startsWith('image/')) return 'image';
  if (/\.(txt|md|csv|text)$/.test(name) || m.startsWith('text/')) return 'text';
  return 'text';
}

/**
 * @returns {Promise<{text:string, source_type:string, extraction:string}>}
 */
async function extractText(buffer, fileName, mime) {
  const source = detectSource(fileName, mime);
  switch (source) {
    case 'pdf':
      return { text: extractPdf(buffer), source_type: 'pdf', extraction: 'PDF stream parser (FlateDecode)' };
    case 'docx':
      return { text: extractDocx(buffer), source_type: 'docx', extraction: 'DOCX (word/document.xml) reader' };
    case 'image': {
      const text = await ocrImage(buffer, fileName);
      return { text, source_type: 'image', extraction: 'OCR (tesseract)' };
    }
    default:
      return { text: buffer.toString('utf8'), source_type: 'txt', extraction: 'plain text decoder' };
  }
}

module.exports = { extractText, extractPdf, extractDocx, detectSource, ocrAvailable };
