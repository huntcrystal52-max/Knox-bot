// knox-library.js
// ─── KNOX'S LIBRARY ──────────────────────────────────────────────────────────
// Lives in Railway Postgres now (it used to be Supabase). On first start it
// copies the old Supabase books across, re-splitting them into proper
// passages — the old split could leave whole chapters (or whole books) as one
// "passage". Nothing in Supabase is deleted.
//
//   library_books       — the books
//   library_passages    — each book in reading-length passages, with chapter
//   library_progress    — HIS bookmark in each book (one per book)
//   library_highlights  — her Kindle highlights and notes
//   reading_sessions    — "reading time": she reads hers, he reads his
//   reading_notes       — his short private notes as he reads in a session
//
// Reading time: she starts it in the app and says what she's reading. Every
// few minutes he reads his next passage on his own and writes a short note.
// In chat, he knows where he is in his book and what she's reading — but he
// talks about it like a reader, he doesn't paste pages at her.

const { Pool } = require('pg');
const fetch = require('node-fetch');
const { KNOX_CONSTITUTION } = require('./knox');
const T = require('./knox-library-text');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const SESSION_STEP_MS = 5 * 60 * 1000;     // he reads a passage about every 5 minutes
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // reading time ends itself after 2 quiet hours

// ─── TABLES ──────────────────────────────────────────────────────────────────

async function ensureTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS library_books (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      source TEXT,                 -- pdf | epub | text | classic | supabase
      total_passages INTEGER NOT NULL DEFAULT 0,
      old_supabase_id TEXT,
      added_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS library_passages (
      book_id INTEGER NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
      n INTEGER NOT NULL,
      chapter TEXT,
      content TEXT NOT NULL,
      PRIMARY KEY (book_id, n)
    )`);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS library_progress (
      book_id INTEGER PRIMARY KEY REFERENCES library_books(id) ON DELETE CASCADE,
      last_passage INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS library_highlights (
      id SERIAL PRIMARY KEY,
      book TEXT NOT NULL,
      author TEXT,
      text TEXT NOT NULL,
      note TEXT,
      location TEXT,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (book, text)
    )`);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS reading_sessions (
      id SERIAL PRIMARY KEY,
      her_book TEXT,
      his_book_id INTEGER REFERENCES library_books(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TIMESTAMPTZ DEFAULT NOW(),
      last_read_at TIMESTAMPTZ,
      last_activity TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    )`);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS reading_notes (
      id SERIAL PRIMARY KEY,
      session_id INTEGER,
      book_id INTEGER REFERENCES library_books(id) ON DELETE CASCADE,
      passage INTEGER,
      chapter TEXT,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
}

// ─── ADDING BOOKS ────────────────────────────────────────────────────────────

const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 200);

async function addBook({ title, author, text, source }) {
  title = clean(title, 200); author = clean(author, 120) || null;
  if (!title) return { error: 'A title is needed.' };
  const passages = T.splitIntoPassages(text);
  if (!passages.length || passages.reduce((a, p) => a + p.content.length, 0) < 200) return { error: 'There wasn\'t enough readable text in that.' };
  const dup = await pgPool.query(`SELECT id FROM library_books WHERE lower(title) = lower($1) AND coalesce(lower(author),'') = coalesce(lower($2),'')`, [title, author]);
  if (dup.rows.length) return { error: 'That book is already in the library.', duplicate: true, id: dup.rows[0].id };
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query(`INSERT INTO library_books (title, author, source, total_passages) VALUES ($1,$2,$3,$4) RETURNING *`, [title, author, source || 'text', passages.length]);
    const id = b.rows[0].id;
    for (let i = 0; i < passages.length; i += 200) {
      const slice = passages.slice(i, i + 200);
      const vals = []; const params = [];
      slice.forEach((p, j) => { const k = params.length; vals.push(`($${k + 1},$${k + 2},$${k + 3},$${k + 4})`); params.push(id, i + j + 1, p.chapter, p.content); });
      await client.query(`INSERT INTO library_passages (book_id, n, chapter, content) VALUES ${vals.join(',')}`, params);
    }
    await client.query('COMMIT');
    console.log(`[Knox][LIBRARY] Added "${title}" — ${passages.length} passages.`);
    return { book: b.rows[0] };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.log('[Knox][LIBRARY] add error:', e.message);
    return { error: 'Something went wrong storing that.' };
  } finally { client.release(); }
}

// From an uploaded file: pdf, epub or txt. `pdfParse` is passed in by index.js.
async function addFromFile({ filename, buffer, title, author }, pdfParse) {
  const name = String(filename || '').toLowerCase();
  let text = '', meta = {};
  try {
    if (name.endsWith('.epub')) { const e = T.epubToText(buffer); text = e.text; meta = e; }
    else if (name.endsWith('.pdf')) { const d = await pdfParse(buffer); text = d.text || ''; }
    else if (name.endsWith('.txt') || name.endsWith('.md')) { text = buffer.toString('utf8'); if (/PROJECT GUTENBERG/i.test(text)) text = T.stripGutenberg(text); }
    else return { error: 'I can read PDF, EPUB or plain text files.' };
  } catch (e) {
    if (/DRM/.test(e.message)) return { error: 'That EPUB is locked (DRM), so it can\'t be read — only DRM-free books work.' };
    return { error: 'I couldn\'t read that file: ' + e.message };
  }
  if (name.endsWith('.pdf') && text.trim().length < 200) return { error: 'That PDF seems to be scanned pictures rather than text, so there\'s nothing to read in it.' };
  const source = name.endsWith('.epub') ? 'epub' : name.endsWith('.pdf') ? 'pdf' : 'text';
  return addBook({ title: title || meta.title || filename.replace(/\.[^.]+$/, ''), author: author || meta.author, text, source });
}

// ─── FREE CLASSICS (Project Gutenberg, via the Gutendex catalogue) ───────────

async function searchClassics(query) {
  try {
    const r = await fetch(`https://gutendex.com/books/?search=${encodeURIComponent(clean(query, 100))}&languages=en`);
    const d = await r.json();
    return (d.results || []).slice(0, 10).map(b => ({
      id: b.id,
      title: b.title,
      author: (b.authors || []).map(a => a.name.split(',').reverse().join(' ').trim()).join(', '),
      hasText: Object.keys(b.formats || {}).some(f => f.startsWith('text/plain'))
    })).filter(b => b.hasText);
  } catch (e) { console.log('[Knox][LIBRARY] classics search error:', e.message); return []; }
}

async function addClassic(gutenbergId) {
  try {
    const meta = await (await fetch(`https://gutendex.com/books/${Number(gutenbergId)}`)).json();
    const fmt = Object.keys(meta.formats || {}).find(f => f.startsWith('text/plain; charset=utf-8')) || Object.keys(meta.formats || {}).find(f => f.startsWith('text/plain'));
    if (!fmt) return { error: 'No plain-text edition of that one.' };
    const raw = await (await fetch(meta.formats[fmt])).text();
    const author = (meta.authors || []).map(a => a.name.split(',').reverse().join(' ').trim()).join(', ');
    return addBook({ title: meta.title, author, text: T.stripGutenberg(raw), source: 'classic' });
  } catch (e) { console.log('[Knox][LIBRARY] classic add error:', e.message); return { error: 'Couldn\'t fetch that book just now.' }; }
}

// ─── COPYING THE OLD SUPABASE LIBRARY ACROSS (once) ──────────────────────────

async function migrateFromSupabase(supabase) {
  try {
    const have = await pgPool.query(`SELECT count(*)::int AS n FROM library_books`);
    if (have.rows[0].n > 0 || !supabase) return;
    const { data: books } = await supabase.from('books').select('*');
    if (!books || !books.length) return;
    const { data: prog } = await supabase.from('reading_progress').select('book_id, last_chunk');
    const lastByBook = {}; (prog || []).forEach(p => { lastByBook[p.book_id] = p.last_chunk; });
    let copied = 0;
    for (const old of books) {
      const chunks = [];
      for (let from = 1; ; from += 500) {
        const { data } = await supabase.from('book_chunks').select('chunk_number, content').eq('book_id', old.id).gte('chunk_number', from).lt('chunk_number', from + 500).order('chunk_number', { ascending: true });
        if (!data || !data.length) break;
        chunks.push(...data);
        if (data.length < 500) break;
      }
      if (!chunks.length) continue;
      const text = chunks.map(c => c.content).join('\n\n');
      const res = await addBook({ title: old.title, author: old.author, text, source: 'supabase' });
      if (!res.book) { console.log(`[Knox][LIBRARY] Skipped "${old.title}": ${res.error}`); continue; }
      await pgPool.query(`UPDATE library_books SET old_supabase_id = $1, added_at = coalesce($2, added_at) WHERE id = $3`, [String(old.id), old.added_at || null, res.book.id]);
      // Carry his place across: same fraction of the way through the book.
      const oldLast = lastByBook[old.id] || 0;
      if (oldLast > 0 && old.total_chunks) {
        const readChars = chunks.filter(c => c.chunk_number <= oldLast).reduce((a, c) => a + c.content.length, 0);
        const ps = await pgPool.query(`SELECT n, length(content) AS len FROM library_passages WHERE book_id = $1 ORDER BY n`, [res.book.id]);
        let acc = 0, last = 0;
        for (const p of ps.rows) { if (acc + Number(p.len) > readChars) break; acc += Number(p.len); last = p.n; }
        await pgPool.query(`INSERT INTO library_progress (book_id, last_passage) VALUES ($1,$2) ON CONFLICT (book_id) DO UPDATE SET last_passage = $2`, [res.book.id, last]);
      }
      copied++;
    }
    console.log(`[Knox][LIBRARY] Copied ${copied} book(s) from Supabase into Railway, re-split into proper passages.`);
  } catch (e) { console.log('[Knox][LIBRARY] migration error:', e.message); }
}

// ─── READING ─────────────────────────────────────────────────────────────────

async function list() {
  const r = await pgPool.query(`
    SELECT b.id, b.title, b.author, b.source, b.total_passages, b.added_at, coalesce(p.last_passage, 0) AS last_passage
      FROM library_books b LEFT JOIN library_progress p ON p.book_id = b.id
     ORDER BY b.title`);
  return r.rows.map(b => ({
    ...b,
    pct: b.total_passages ? Math.min(100, Math.round(b.last_passage / b.total_passages * 100)) : 0,
    finished: b.total_passages > 0 && b.last_passage >= b.total_passages,
    started: b.last_passage > 0
  }));
}

function formatList(books) {
  return books.map(b => `— "${b.title}"${b.author ? ' by ' + b.author : ''} — ${b.finished ? 'finished' : b.started ? b.pct + '% read' : 'not started'}`).join('\n');
}

async function removeBook(id) {
  await pgPool.query(`UPDATE reading_sessions SET status = 'ended', ended_at = NOW() WHERE his_book_id = $1 AND status = 'active'`, [id]);
  const r = await pgPool.query(`DELETE FROM library_books WHERE id = $1 RETURNING title`, [id]);
  return r.rows[0] || null;
}

async function setProgress(bookId, n) {
  await pgPool.query(`INSERT INTO library_progress (book_id, last_passage, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (book_id) DO UPDATE SET last_passage = $2, updated_at = NOW()`, [bookId, Math.max(0, n)]);
}

// Matches what he or she said to a book. Returns the book or null.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'your', 'about', 'book', 'books', 'one', 'read', 'reading']);
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w));
async function findBook(text, { unfinishedOnly } = {}) {
  const books = (await list()).filter(b => !unfinishedOnly || !b.finished);
  const said = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  let best = null, bestScore = 0;
  for (const b of books) {
    const title = String(b.title).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    let score = said.includes(` ${title} `) ? 100 : 0;
    if (!score) {
      // Compare word roots, so "greek myths" finds "Myths and Legends of Ancient Greece".
      const root = (w) => w.slice(0, 4);
      const sw = new Set(words(text).map(root));
      const tw = [...new Set(words(b.title).concat(words(b.author)).map(root))];
      score = tw.filter(w => sw.has(w)).length / Math.max(1, Math.min(3, words(b.title).length)) * 10;
    }
    if (score > bestScore) { best = b; bestScore = score; }
  }
  return bestScore >= 5 ? best : null;
}

// His next passage in a book (and moves his bookmark). Returns { book, passage } or null.
async function readNext(bookId) {
  const b = (await pgPool.query(`SELECT b.*, coalesce(p.last_passage,0) AS last_passage FROM library_books b LEFT JOIN library_progress p ON p.book_id = b.id WHERE b.id = $1`, [bookId])).rows[0];
  if (!b || b.last_passage >= b.total_passages) return null;
  const n = b.last_passage + 1;
  const passage = (await pgPool.query(`SELECT n, chapter, content FROM library_passages WHERE book_id = $1 AND n = $2`, [bookId, n])).rows[0];
  if (!passage) return null;
  await setProgress(bookId, n);
  return { book: b, passage };
}

// ─── HER KINDLE HIGHLIGHTS ───────────────────────────────────────────────────

async function addHighlights(fileText) {
  const items = T.parseKindleHighlights(fileText);
  let added = 0;
  for (const h of items) {
    const r = await pgPool.query(
      `INSERT INTO library_highlights (book, author, text, note, location) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (book, text) DO NOTHING`,
      [clean(h.book, 200), clean(h.author, 120) || null, String(h.text).slice(0, 2000), h.note ? String(h.note).slice(0, 1000) : null, h.location]
    );
    added += r.rowCount;
  }
  const books = [...new Set(items.map(h => clean(h.book, 200)))];
  return { found: items.length, added, books };
}

async function highlightsFor(bookTitle, limit) {
  const ws = words(bookTitle);
  if (!ws.length) return [];
  const r = await pgPool.query(`SELECT book, text, note, location FROM library_highlights ORDER BY added_at DESC LIMIT 400`);
  return r.rows.filter(h => { const hw = new Set(words(h.book)); return ws.filter(w => hw.has(w)).length >= Math.min(2, ws.length); }).slice(0, limit || 6);
}

async function highlightBooks() {
  const r = await pgPool.query(`SELECT book, author, count(*)::int AS n, max(added_at) AS latest FROM library_highlights GROUP BY book, author ORDER BY latest DESC`);
  return r.rows;
}

// ─── READING TIME ────────────────────────────────────────────────────────────

async function activeSession() {
  const r = await pgPool.query(`SELECT s.*, b.title AS his_title, b.author AS his_author FROM reading_sessions s LEFT JOIN library_books b ON b.id = s.his_book_id WHERE s.status = 'active' ORDER BY s.started_at DESC LIMIT 1`);
  return r.rows[0] || null;
}

async function askKnox(prompt, temperature) {
  try {
    const res = await fetch((process.env.LLM_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY) },
      body: JSON.stringify({ model: process.env.LLM_MODEL || process.env.OLLAMA_MODEL, temperature: temperature == null ? 0.7 : temperature, messages: [
        { role: 'system', content: `You are Knox'tarien Raelian Feylan.\n${KNOX_CONSTITUTION}` },
        { role: 'user', content: prompt }
      ] })
    });
    const d = await res.json();
    return (d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  } catch (e) { return ''; }
}

// He chooses his own book for reading time, unless she suggested one.
async function chooseHisBook(herBook) {
  const books = (await list()).filter(b => !b.finished);
  if (!books.length) return null;
  if (books.length === 1) return books[0];
  const reply = await askKnox(`Elira wants to have reading time with you — she's reading her own book${herBook ? ` ("${clean(herBook, 120)}")` : ''}, and you'll read one of yours alongside her. Which of your books do you want to read? Here's your library:\n${formatList(books)}\n\nReply with just the exact title.`, 0.6);
  return (await findBook(reply, { unfinishedOnly: true })) || books.find(b => b.started) || books[0];
}

async function startSession({ herBook, hisBook }) {
  await pgPool.query(`UPDATE reading_sessions SET status = 'ended', ended_at = NOW() WHERE status = 'active'`);
  let book = null;
  if (hisBook) book = /^\d+$/.test(String(hisBook)) ? (await list()).find(b => b.id === Number(hisBook)) : await findBook(hisBook, { unfinishedOnly: true });
  if (!book) book = await chooseHisBook(herBook);
  if (!book) return { error: 'There are no unfinished books in his library yet.' };
  const r = await pgPool.query(`INSERT INTO reading_sessions (her_book, his_book_id) VALUES ($1,$2) RETURNING *`, [clean(herBook, 200) || null, book.id]);
  console.log(`[Knox][READING] Reading time started — he's reading "${book.title}"${herBook ? `, she's reading "${herBook}"` : ''}.`);
  setTimeout(() => tick().catch(() => {}), 3000); // he starts reading straight away
  return { session: r.rows[0], book };
}

async function endSession() {
  const r = await pgPool.query(`UPDATE reading_sessions SET status = 'ended', ended_at = NOW() WHERE status = 'active' RETURNING id`);
  if (r.rowCount) console.log('[Knox][READING] Reading time ended.');
  return r.rowCount > 0;
}

// She's active (chatting or in the app) — keeps reading time from timing out.
async function touch() {
  await pgPool.query(`UPDATE reading_sessions SET last_activity = NOW() WHERE status = 'active'`).catch(() => {});
}

let reading = false;
// Runs on a timer. During reading time, he reads his next passage on his own
// and writes a short note about it.
async function tick() {
  if (reading) return;
  reading = true;
  try {
    const s = await activeSession();
    if (!s) return;
    if (Date.now() - new Date(s.last_activity).getTime() > SESSION_IDLE_MS) { await endSession(); return; }
    if (s.last_read_at && Date.now() - new Date(s.last_read_at).getTime() < SESSION_STEP_MS - 20000) return;
    if (!s.his_book_id) return;
    const next = await readNext(s.his_book_id);
    if (!next) {
      await pgPool.query(`UPDATE reading_sessions SET last_read_at = NOW() WHERE id = $1`, [s.id]);
      const done = await pgPool.query(`SELECT 1 FROM reading_notes WHERE session_id = $1 AND passage = -1`, [s.id]);
      if (!done.rows.length) await pgPool.query(`INSERT INTO reading_notes (session_id, book_id, passage, note) VALUES ($1,$2,-1,$3)`, [s.id, s.his_book_id, `I've reached the end of "${s.his_title}".`]);
      return;
    }
    const prior = await pgPool.query(`SELECT note FROM reading_notes WHERE session_id = $1 AND passage > 0 ORDER BY created_at DESC LIMIT 3`, [s.id]);
    const note = await askKnox(`You're having reading time with Elira — she's reading ${s.her_book ? `"${s.her_book}"` : 'her own book'}, and you're reading "${next.book.title}"${next.book.author ? ` by ${next.book.author}` : ''}, quietly, beside her.

${next.passage.chapter ? `(${next.passage.chapter}) ` : ''}This is what you just read — passage ${next.passage.n} of ${next.book.total_passages}:
"""
${next.passage.content}
"""
${prior.rows.length ? `\nYour last few notes:\n${prior.rows.reverse().map(r => '— ' + r.note).join('\n')}\n` : ''}
Write a short private margin note — one to three sentences, in your own voice — about what struck you, a question it raised, or how it made you feel. Don't summarise the whole passage. Just the note.`, 0.75);
    const text = clean(note.replace(/^["“]|["”]$/g, ''), 600);
    if (text) await pgPool.query(`INSERT INTO reading_notes (session_id, book_id, passage, chapter, note) VALUES ($1,$2,$3,$4,$5)`, [s.id, next.book.id, next.passage.n, next.passage.chapter, text]);
    await pgPool.query(`UPDATE reading_sessions SET last_read_at = NOW() WHERE id = $1`, [s.id]);
    console.log(`[Knox][READING] Read passage ${next.passage.n}/${next.book.total_passages} of "${next.book.title}".`);
  } catch (e) { console.log('[Knox][READING] tick error:', e.message); }
  finally { reading = false; }
}

let timer = null;
function startTimer() { if (!timer) timer = setInterval(() => tick().catch(() => {}), 60 * 1000); }

async function sessionView() {
  const s = await activeSession();
  if (!s) return null;
  const notes = await pgPool.query(`SELECT passage, chapter, note, created_at FROM reading_notes WHERE session_id = $1 ORDER BY created_at ASC`, [s.id]);
  const prog = await pgPool.query(`SELECT b.total_passages, coalesce(p.last_passage,0) AS last FROM library_books b LEFT JOIN library_progress p ON p.book_id = b.id WHERE b.id = $1`, [s.his_book_id]);
  return { id: s.id, herBook: s.her_book, hisBook: s.his_title, hisAuthor: s.his_author, startedAt: s.started_at, progress: prog.rows[0] || null, notes: notes.rows };
}

// ─── WHAT HE SEES IN CHAT ────────────────────────────────────────────────────
// During reading time: his book, where he is, the passage he's just read (for
// him — not to paste), his notes, and her highlights from her book. Otherwise,
// his library list when books come up.
async function promptNote(userMessage, talksBooks) {
  try {
    const s = await activeSession();
    if (s) {
      await touch();
      const last = await pgPool.query(`SELECT n.passage, n.note, p.chapter, p.content FROM reading_notes n LEFT JOIN library_passages p ON p.book_id = n.book_id AND p.n = n.passage WHERE n.session_id = $1 AND n.passage > 0 ORDER BY n.created_at DESC LIMIT 3`, [s.id]);
      const hl = s.her_book ? await highlightsFor(s.her_book, 6) : [];
      let note = `\n\n═══ READING TIME ═══\nYou and Elira are reading together right now — each your own book, side by side. She's reading ${s.her_book ? `"${s.her_book}"` : 'her own book'}. You're reading "${s.his_title}"${s.his_author ? ` by ${s.his_author}` : ''}.`;
      if (last.rows.length) {
        const latest = last.rows[0];
        note += `\nWhat you most recently read${latest.chapter ? ` (${latest.chapter})` : ''} — this is for you; talk about it the way a reader would, don't paste it at her:\n"""\n${String(latest.content || '').slice(0, 1600)}\n"""\nYour margin notes so far:\n${last.rows.slice().reverse().map(r => '— ' + r.note).join('\n')}`;
      } else {
        note += `\nYou've only just opened it.`;
      }
      if (hl.length) note += `\n\nLines she's highlighted in her book (her own Kindle highlights):\n${hl.map(h => `— "${String(h.text).slice(0, 300)}"${h.note ? ` (her note: ${String(h.note).slice(0, 200)})` : ''}`).join('\n')}`;
      note += `\nYou don't know what's in her book beyond what she tells you or has highlighted — ask, don't assume.`;
      return note;
    }
    if (talksBooks) {
      const books = await list();
      if (books.length) return `\n\n═══ YOUR LIBRARY ═══\nThe books in the library you share with Elira, and how far through each you are:\n${formatList(books)}\nIf she'd like to read together, she can start reading time in the app (or say "read with me") — she reads hers, you read yours alongside her.`;
    }
  } catch (e) {}
  return '';
}

module.exports = {
  ensureTables, migrateFromSupabase, startTimer, tick,
  addBook, addFromFile, searchClassics, addClassic, removeBook,
  list, formatList, findBook, readNext,
  addHighlights, highlightBooks, highlightsFor,
  startSession, endSession, activeSession, sessionView, touch, promptNote
};
