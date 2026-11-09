// knox-library-text.js
// ─── TURNING FILES INTO READABLE PASSAGES ────────────────────────────────────
// Pure text helpers for the library — no database, no network — so they can be
// tested on their own:
//   splitIntoPassages  — book text → passages of a sensible reading length,
//                        starting fresh at each chapter
//   epubToText         — an .epub file → its text, in reading order
//   stripGutenberg     — removes Project Gutenberg's licence header/footer
//   parseKindleHighlights — "My Clippings.txt" or a Kindle notebook export → highlights

const zlib = require('zlib');

const TARGET = 1500;   // aim for about this many characters per passage
const MAX = 2200;      // never let one run much past this
const MIN = 600;       // don't end a passage this short unless a chapter starts

// ─── SPLITTING ───────────────────────────────────────────────────────────────

const WORD_NUM = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?';
const CHAPTER = new RegExp(`^(?:chapter|book|part|canto|act)\\s+(?:[0-9]+|[ivxlcdm]+|${WORD_NUM})\\b.{0,80}$|^(?:prologue|epilogue|preface|introduction|foreword|afterword)\\b.{0,60}$`, 'i');

function normalise(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '')                 // soft hyphens
    .replace(/[ \t]+\n/g, '\n')
    .replace(/-\n(?=[a-z])/g, '')           // words hyphenated across lines (PDFs)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Paragraphs, even when the text has no blank lines (common in PDFs): a line
// ending a sentence followed by a line starting a new one counts as a break.
// Chapter headings always stand as their own paragraph.
function paragraphs(text) {
  const t = normalise(text).split('\n').map(l => (l.trim().length <= 90 && CHAPTER.test(l.trim()) ? `\n${l.trim()}\n` : l)).join('\n').replace(/\n{3,}/g, '\n\n');
  const blankSplit = t.split(/\n\s*\n/);
  const looksFlat = blankSplit.length < Math.max(3, t.length / 4000);
  const raw = looksFlat ? t.split(/(?<=[.!?:"”’)])\n(?=[A-Z"“‘(])/) : blankSplit;
  return raw.map(p => p.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
}

// Breaks one very long paragraph at sentence ends.
function bySentences(p) {
  if (p.length <= MAX) return [p];
  const sentences = p.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) || [p];
  const out = []; let cur = '';
  for (const s of sentences) {
    if (cur && (cur + s).length > TARGET) { out.push(cur.trim()); cur = ''; }
    if (s.length > MAX) { for (let i = 0; i < s.length; i += TARGET) out.push(s.slice(i, i + TARGET).trim()); continue; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Returns [{ chapter, content }]
function splitIntoPassages(text) {
  const passages = [];
  let chapter = null;
  let cur = [];
  let len = 0;
  const flush = () => {
    if (cur.length) passages.push({ chapter, content: cur.join('\n\n') });
    cur = []; len = 0;
  };
  for (const para of paragraphs(text)) {
    if (para.length <= 90 && CHAPTER.test(para)) {
      flush();
      chapter = para.replace(/\s+/g, ' ').slice(0, 80);
      continue;
    }
    for (const piece of bySentences(para)) {
      if (len >= MIN && len + piece.length > TARGET) flush();
      cur.push(piece); len += piece.length + 2;
      if (len >= MAX) flush();
    }
  }
  flush();
  return passages;
}

// ─── PROJECT GUTENBERG ───────────────────────────────────────────────────────

function stripGutenberg(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  const start = t.search(/\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  if (start !== -1) t = t.slice(t.indexOf('\n', start) + 1);
  const end = t.search(/\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i);
  if (end !== -1) t = t.slice(0, end);
  return t.trim();
}

// ─── EPUB (a zip of web pages) ───────────────────────────────────────────────
// A tiny zip reader so no extra package is needed: finds each file in the
// zip's central directory and unpacks it with Node's built-in zlib.

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    files[name] = () => {
      const lNameLen = buf.readUInt16LE(local + 26);
      const lExtraLen = buf.readUInt16LE(local + 28);
      const data = buf.slice(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error('unsupported zip compression');
    };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|tr)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] || m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function epubToText(buf) {
  const files = readZip(buf);
  const read = (name) => (files[name] ? files[name]().toString('utf8') : null);
  const container = read('META-INF/container.xml');
  if (!container) throw new Error('not an EPUB (no container.xml)');
  const opfPath = (container.match(/full-path="([^"]+)"/) || [])[1];
  const opf = opfPath && read(opfPath);
  if (!opf) throw new Error('EPUB is missing its contents list');
  if (/encryption\.xml/.test(Object.keys(files).join(' ')) && read('META-INF/encryption.xml') && /EncryptedData/.test(read('META-INF/encryption.xml'))) {
    throw new Error('this EPUB is DRM-protected');
  }
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = {};
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = (m[0].match(/\bid="([^"]+)"/) || [])[1];
    const href = (m[0].match(/\bhref="([^"]+)"/) || [])[1];
    if (id && href) manifest[id] = decodeURIComponent(href);
  }
  const order = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map(m => manifest[m[1]]).filter(Boolean);
  const title = ((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/) || [])[1] || '').trim();
  const author = ((opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/) || [])[1] || '').trim();
  const parts = [];
  for (const href of order) {
    const html = read(base + href);
    if (html) parts.push(htmlToText(html));
  }
  return { title: htmlToText(title), author: htmlToText(author), text: parts.join('\n\n') };
}

// ─── KINDLE HIGHLIGHTS ───────────────────────────────────────────────────────
// Accepts either a Kindle e-reader's "My Clippings.txt", or the HTML file the
// Kindle app makes when you export a book's notebook.
// Returns [{ book, author, text, note, location }]

function parseKindleHighlights(input) {
  const s = String(input || '');
  if (/class=["']?noteText/i.test(s)) return parseNotebookHtml(s);
  if (s.includes('==========')) return parseClippings(s);
  return [];
}

function parseClippings(s) {
  const out = [];
  const blocks = s.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split(/\n?==========\n?/);
  for (const b of blocks) {
    const lines = b.split('\n').map(l => l.trim());
    while (lines.length && !lines[0]) lines.shift();
    if (lines.length < 3) continue;
    const head = lines[0].replace(/^﻿/, '');
    const meta = lines[1] || '';
    const body = lines.slice(2).join('\n').trim();
    if (!body || /bookmark/i.test(meta)) continue;
    const am = head.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    const book = (am ? am[1] : head).trim();
    const author = am ? am[2].trim() : '';
    const location = ((meta.match(/(?:page|location|Location|Page)\s+[\d-]+/g) || []).join(', ')) || null;
    if (/your note/i.test(meta)) {
      // A note attaches to the highlight just before it, if it's the same book.
      const prev = out[out.length - 1];
      if (prev && prev.book === book && !prev.note) { prev.note = body; continue; }
      out.push({ book, author, text: body, note: null, location, isNote: true });
      continue;
    }
    out.push({ book, author, text: body, note: null, location });
  }
  return out;
}

function parseNotebookHtml(s) {
  const book = htmlToText((s.match(/class=["']?bookTitle["']?[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
  const author = htmlToText((s.match(/class=["']?authors["']?[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
  const out = [];
  const re = /class=["']?noteHeading["']?[^>]*>([\s\S]*?)<\/(?:div|h3)>\s*<div[^>]*class=["']?noteText["']?[^>]*>([\s\S]*?)<\/(?:div|h3)>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const heading = htmlToText(m[1]);
    const text = htmlToText(m[2]);
    if (!text) continue;
    const location = ((heading.match(/(?:Page|Location)\s+[\d-]+/gi) || []).join(', ')) || null;
    if (/^note/i.test(heading)) {
      const prev = out[out.length - 1];
      if (prev && !prev.note) { prev.note = text; continue; }
    }
    out.push({ book, author, text, note: null, location });
  }
  return out;
}

module.exports = { splitIntoPassages, stripGutenberg, epubToText, htmlToText, parseKindleHighlights, readZip };
