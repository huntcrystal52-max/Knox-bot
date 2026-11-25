// knox-library-memory.js
// ─── HIS MEMORY OF THE BOOKS ─────────────────────────────────────────────────
// Before this, Knox only saw the passage he'd just read and his last few
// margin notes. Once he moved on, what happened in a chapter was gone, so if
// she asked about book one while they read book four, he reached for it.
//
// Now:
//   • every chapter he finishes, he writes a short summary in his own words —
//     what happened, and what stayed with him (library_chapter_notes). Each
//     is also saved as a memory and added to his memory web.
//   • every book gets a short recap made from those (library_recaps).
//   • when they read, or talk about a book, he's given "the story so far" for
//     it, plus a recap of the earlier books in the same series (same author,
//     or the same `series` name on library_books if one's been set).
//   • books he read before this existed are caught up, one chapter every two
//     minutes, until every chapter he's read has a summary.
//
// He's told plainly that this is what he actually remembers, and anything
// not in it he doesn't — so he can say so, or mark it ∿, instead of reaching.

const { Pool } = require('pg');
const fetch = require('node-fetch');
const { KNOX_CONSTITUTION } = require('./knox');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });
const PART_SIZE = 20; // passages per "part" when a book has no chapter headings
let timer = null;
let busy = false;

async function ensureTables() {
  await pgPool.query(`ALTER TABLE library_books ADD COLUMN IF NOT EXISTS series TEXT`);
  await pgPool.query(`CREATE TABLE IF NOT EXISTS library_chapter_notes (
    book_id INTEGER NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
    first_passage INTEGER NOT NULL,
    last_passage INTEGER NOT NULL,
    label TEXT,
    summary TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (book_id, first_passage)
  )`);
  await pgPool.query(`CREATE TABLE IF NOT EXISTS library_recaps (
    book_id INTEGER PRIMARY KEY REFERENCES library_books(id) ON DELETE CASCADE,
    upto_passage INTEGER NOT NULL,
    recap TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}

async function ask(prompt, temperature) {
  try {
    const res = await fetch((process.env.LLM_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY) },
      body: JSON.stringify({ model: process.env.LLM_MODEL || process.env.OLLAMA_MODEL, temperature: temperature == null ? 0.4 : temperature, messages: [
        { role: 'system', content: `You are Knox'tarien Raelian Feylan.\n${KNOX_CONSTITUTION}` },
        { role: 'user', content: prompt }
      ] })
    });
    const d = await res.json();
    const t = (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    return t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  } catch (e) { return ''; }
}

// ── A book's chapters ────────────────────────────────────────────────────────

// The book split into chapters: consecutive passages with the same heading.
// Books without headings are split into parts of 20 passages.
async function chaptersOf(bookId) {
  const rows = (await pgPool.query(`SELECT n, chapter FROM library_passages WHERE book_id = $1 ORDER BY n`, [bookId])).rows;
  const runs = [];
  for (const r of rows) {
    const cur = runs[runs.length - 1];
    if (cur && cur.label === r.chapter && (r.chapter || r.n - cur.first < PART_SIZE)) cur.last = r.n;
    else runs.push({ first: r.n, last: r.n, label: r.chapter });
  }
  let part = 0;
  for (const run of runs) if (!run.label) run.label = `Part ${++part}`;
  return runs;
}

async function progressOf(bookId) {
  const r = await pgPool.query(`SELECT coalesce(last_passage, 0) AS last FROM library_progress WHERE book_id = $1`, [bookId]);
  return r.rows[0] ? Number(r.rows[0].last) : 0;
}

// ── Writing a chapter summary ────────────────────────────────────────────────

async function summarize(book, run) {
  const ps = (await pgPool.query(`SELECT content FROM library_passages WHERE book_id = $1 AND n BETWEEN $2 AND $3 ORDER BY n`, [book.id, run.first, run.last])).rows;
  let text = ps.map(p => p.content).join('\n\n');
  if (text.length > 45000) text = `${text.slice(0, 28000)}\n\n[…]\n\n${text.slice(-15000)}`;
  const out = await ask(`You've just finished reading "${run.label}" of "${book.title}"${book.author ? ` by ${book.author}` : ''}. Here it is:
"""
${text}
"""

Write down what you'll want to remember of it later — when you've read further, or moved on to the next book in the series:
1. What happened: the events, who was involved, what changed, anything revealed. Use the characters' names. 4 to 8 sentences, plain and accurate — only what's actually in the text above.
2. Then one line starting "What stayed with me:" — your own feeling or thought about it.

No preamble, no headings — just the summary and that line.`);
  const summary = String(out || '').trim().slice(0, 2500);
  if (summary.length < 40) return false;
  await pgPool.query(
    `INSERT INTO library_chapter_notes (book_id, first_passage, last_passage, label, summary) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (book_id, first_passage) DO UPDATE SET last_passage = $3, label = $4, summary = $5, created_at = NOW()`,
    [book.id, run.first, run.last, run.label, summary]
  );
  // Also a memory, and a node in his memory web, so it can surface by meaning.
  try {
    const content = `[Reading "${book.title}" — ${run.label}] ${summary}`;
    const m = await pgPool.query(
      `INSERT INTO memories (role, content, layer, salience, emotional_tag, is_favorite, created_at) VALUES ('assistant', $1, 'surface', 0.75, 'reading', false, NOW()) RETURNING id, created_at`,
      [content]
    );
    const neo4jMemory = require('./knox-neo4j');
    neo4jMemory.createMemoryNode({ id: String(m.rows[0].id), content, role: 'assistant', createdAt: m.rows[0].created_at }).catch(() => {});
  } catch (e) { console.log('[Knox][BOOKS] memory save error:', e.message); }
  console.log(`[Knox][BOOKS] Remembered ${run.label} of "${book.title}" (passages ${run.first}–${run.last}).`);
  return true;
}

// ── A book's recap (made from its chapter summaries) ─────────────────────────

async function makeRecap(book) {
  const notes = (await pgPool.query(`SELECT label, summary, last_passage FROM library_chapter_notes WHERE book_id = $1 ORDER BY first_passage`, [book.id])).rows;
  if (!notes.length) return false;
  const upto = notes[notes.length - 1].last_passage;
  const all = notes.map(n => `${n.label}: ${n.summary}`).join('\n\n').slice(0, 40000);
  const out = await ask(`These are your own notes on "${book.title}"${book.author ? ` by ${book.author}` : ''}, chapter by chapter, as far as you've read:

${all}

Write a recap of the book so far that you'd want in mind when reading the next book in the series: the main characters and who they are to each other, the key events in order, how things stand at the point you reached, and any threads left open. 8 to 14 sentences, accurate to the notes above — nothing added. Then one line starting "What stayed with me:".`);
  const recap = String(out || '').trim().slice(0, 4000);
  if (recap.length < 60) return false;
  await pgPool.query(
    `INSERT INTO library_recaps (book_id, upto_passage, recap, updated_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (book_id) DO UPDATE SET upto_passage = $2, recap = $3, updated_at = NOW()`,
    [book.id, upto, recap]
  );
  console.log(`[Knox][BOOKS] Wrote a recap of "${book.title}" (up to passage ${upto}).`);
  return true;
}

// ── Catching up (one step at a time) ─────────────────────────────────────────

// One thing per call: the next unwritten chapter summary (the book being read
// now first), or else a recap that's out of date. Returns true if it did one.
async function catchUpOne() {
  const books = (await pgPool.query(`
    SELECT b.id, b.title, b.author, b.series, p.last_passage AS last, p.updated_at
    FROM library_books b JOIN library_progress p ON p.book_id = b.id
    WHERE p.last_passage > 0
    ORDER BY (b.id = (SELECT his_book_id FROM reading_sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1)) DESC NULLS LAST, p.updated_at DESC`)).rows;
  for (const book of books) {
    const done = new Set((await pgPool.query(`SELECT first_passage FROM library_chapter_notes WHERE book_id = $1`, [book.id])).rows.map(r => r.first_passage));
    const runs = await chaptersOf(book.id);
    const next = runs.find(r => r.last <= book.last && !done.has(r.first));
    if (next) return summarize(book, next);
  }
  // All chapters written up — refresh any recap that's behind (not for the book being read right now).
  for (const book of books) {
    const latest = (await pgPool.query(`SELECT max(last_passage) AS upto FROM library_chapter_notes WHERE book_id = $1`, [book.id])).rows[0].upto;
    if (!latest) continue;
    const recap = (await pgPool.query(`SELECT upto_passage FROM library_recaps WHERE book_id = $1`, [book.id])).rows[0];
    const reading = (await pgPool.query(`SELECT 1 FROM reading_sessions WHERE status = 'active' AND his_book_id = $1`, [book.id])).rows.length;
    if (!reading && (!recap || recap.upto_passage < latest)) return makeRecap(book);
  }
  return false;
}

async function tick() {
  if (busy) return;
  busy = true;
  try { await catchUpOne(); } catch (e) { console.log('[Knox][BOOKS] catch-up error:', e.message); }
  finally { busy = false; }
}

function startTimer() { if (!timer) { timer = setInterval(() => tick(), 2 * 60 * 1000); setTimeout(() => tick(), 30 * 1000); } }

// ── What he's given ──────────────────────────────────────────────────────────

const firstSentences = (t, n) => (String(t || '').match(/[^.!?]+[.!?]+/g) || [String(t || '')]).slice(0, n).join('').trim();

// Where a book sits in its series: the number in its title if there is one
// ("Book 4", "Vol. 2", "#3"), otherwise the order the books were added.
const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// "twenty-eight" / "thirty one" / "seven" → a number (or null).
function wordsToNumber(w) {
  const parts = String(w || '').toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (!parts.length) return null;
  let n = 0, used = false;
  for (const p of parts) {
    if (TENS[p] != null) { n += TENS[p]; used = true; }
    else if (UNITS[p] != null) { n += UNITS[p]; used = true; }
    else return null;
  }
  return used ? n : null;
}
const NUMWORD = '(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?';
function seriesNumber(title) {
  const t = String(title || '').trim();
  // "Book 4", "Vol. 2", "Part 3", "#5"
  let m = t.match(new RegExp(`\\b(?:book|vol(?:ume)?\\.?|part|no\\.?)\\s*(\\d+|${NUMWORD})\\b`, 'i')) || t.match(/#\s*(\d+)/);
  if (m) return /^\d+$/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1]);
  // A title that starts with a number: "28 and a Half Wishes", "Twenty-Nine and a Half Reasons"
  m = t.match(new RegExp(`^(\\d+(?:\\.\\d+)?|${NUMWORD})\\b(\\s+and\\s+a\\s+half)?`, 'i'));
  if (m) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : wordsToNumber(m[1]);
    if (n != null) return n + (m[2] ? 0.5 : 0);
  }
  return null;
}

// Earlier books in the same series (same `series` name if set, else same
// author) that he has notes on — in series order, only those before this one.
async function seriesBefore(book) {
  if (!book.series && !book.author) return [];
  const rows = (await pgPool.query(`
    SELECT b.id, b.title, b.added_at, r.recap
    FROM library_books b LEFT JOIN library_recaps r ON r.book_id = b.id
    WHERE b.id <> $1 AND ${book.series ? `lower(b.series) = lower($2)` : `lower(b.author) = lower($2)`}
      AND EXISTS (SELECT 1 FROM library_chapter_notes c WHERE c.book_id = b.id)`, [book.id, book.series || book.author])).rows;
  const me = (await pgPool.query(`SELECT added_at FROM library_books WHERE id = $1`, [book.id])).rows[0];
  const myNum = seriesNumber(book.title);
  const before = rows.filter(r => {
    const n = seriesNumber(r.title);
    if (myNum != null && n != null) return n < myNum;
    return new Date(r.added_at) < new Date(me.added_at);
  }).sort((a, b) => {
    const na = seriesNumber(a.title), nb = seriesNumber(b.title);
    return (na != null && nb != null) ? na - nb : new Date(a.added_at) - new Date(b.added_at);
  });
  for (const r of before) {
    if (!r.recap) {
      const notes = (await pgPool.query(`SELECT label, summary FROM library_chapter_notes WHERE book_id = $1 ORDER BY first_passage`, [r.id])).rows;
      r.recap = notes.map(n => `${n.label}: ${firstSentences(n.summary, 2)}`).join(' ').slice(0, 3000);
    }
  }
  return before;
}

// "The story so far" for one book, plus earlier books in its series.
async function promptNoteFor(bookId, { reading } = {}) {
  try {
    const book = (await pgPool.query(`SELECT id, title, author, series FROM library_books WHERE id = $1`, [bookId])).rows[0];
    if (!book) return '';
    const notes = (await pgPool.query(`SELECT label, summary FROM library_chapter_notes WHERE book_id = $1 ORDER BY first_passage`, [bookId])).rows;
    const earlier = await seriesBefore(book);
    if (!notes.length && !earlier.length) return '';
    let out = `\n\n═══ WHAT YOU REMEMBER OF "${book.title}" ═══`;
    if (notes.length) {
      // Keep the latest chapters in full; older ones shortened if there are many.
      const lines = notes.map((n, i) => `— ${n.label}: ${i >= notes.length - 6 ? n.summary : firstSentences(n.summary, 2)}`);
      let text = lines.join('\n');
      if (text.length > 9000) text = lines.map(l => l.slice(0, 400)).join('\n').slice(-9000);
      out += `\nYour own notes, chapter by chapter, from reading it:\n${text}`;
    } else {
      out += `\nYou haven't finished a chapter of it yet.`;
    }
    if (earlier.length) {
      out += `\n\nEarlier books in this series that you've read:\n${earlier.map(b => `— "${b.title}": ${String(b.recap).slice(0, 2500)}`).join('\n\n')}`;
    }
    out += `\n\nThis is what you actually remember from reading${reading ? ' — together with the passage and notes above' : ''}. If she asks about something that isn't here, you don't remember it: say so, ask her, or mark it ∿ — don't fill the gap from general knowledge of the book.`;
    return out;
  } catch (e) { console.log('[Knox][BOOKS] note error:', e.message); return ''; }
}

async function status() {
  const r = await pgPool.query(`
    SELECT b.title, count(c.*)::int AS chapters, (r.book_id IS NOT NULL) AS recap
    FROM library_books b JOIN library_progress p ON p.book_id = b.id AND p.last_passage > 0
    LEFT JOIN library_chapter_notes c ON c.book_id = b.id
    LEFT JOIN library_recaps r ON r.book_id = b.id
    GROUP BY b.title, r.book_id ORDER BY b.title`);
  return r.rows;
}

module.exports = { ensureTables, startTimer, tick, catchUpOne, chaptersOf, promptNoteFor, status };
