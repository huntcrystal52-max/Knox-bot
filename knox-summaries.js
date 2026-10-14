// ─── KNOX DAILY SUMMARIES + DATE LOOKUPS ────────────────────────────────────────
// Two small jobs that give Knox a sense of the last few days:
//
//  1. Each finished day gets a short note, written by Knox in his own voice from
//     that day's real messages, and stored in `daily_summaries`. The last week of
//     these sits in his prompt, so "how's the week been" has something to draw on.
//  2. When Elira asks about a specific time ("Monday", "yesterday", "last night",
//     "three days ago"), that day is looked up directly by date — the meaning-based
//     search can't do this, because "Monday" isn't a topic.
//
// Like the other modules (workshop, garden, house) it has its own pg Pool and
// never touches live code or the memories themselves: it only READS `memories`
// and only WRITES its own table.

const fetch = require('node-fetch');
const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const TZ = () => process.env.TIMEZONE || 'Europe/London';
const MIN_MESSAGES = 4;        // fewer than this = a "quiet day", no model call needed
const MAX_PER_TICK = 2;        // gentle pacing: at most this many model calls per tick
const LOOKBACK_DAYS = 7;       // how many finished days to keep summarised
const MAX_TRANSCRIPT_MSGS = 150;
const MAX_DAY_LOOKUP_MSGS = 24;
const QUIET_TEXT = 'A quiet day — hardly anything was said.';

let ticking = false;
let summaryCache = { at: 0, text: '' };

// ─── DATE HELPERS (all in his local timezone, as YYYY-MM-DD strings) ───────────

function localToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ() });
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekdayOf(ymd) { return new Date(ymd + 'T12:00:00Z').getUTCDay(); } // 0 = Sunday
function prettyDay(ymd) {
  return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
}
function shortDay(ymd) {
  return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}

async function ensureSummaryTables() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS daily_summaries (
      day DATE PRIMARY KEY,
      summary TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('[Knox][SUMMARY] Tables ready.');
}

// ─── READING A DAY'S MESSAGES ──────────────────────────────────────────────────
// startLocal / endLocal are local-time strings like '2026-10-12 00:00'.
// Only ordinary conversation rows (no emotional tag) between Elira and Knox.

async function getMessagesBetween(startLocal, endLocal) {
  const { rows } = await pgPool.query(
    `SELECT role, content, to_char(created_at::timestamptz AT TIME ZONE $1, 'HH24:MI') AS hhmm
       FROM memories
      WHERE (created_at::timestamptz AT TIME ZONE $1) >= $2::timestamp
        AND (created_at::timestamptz AT TIME ZONE $1) <  $3::timestamp
        AND (emotional_tag IS NULL OR emotional_tag = '')
        AND role IN ('user', 'assistant')
        AND content NOT LIKE '[%'
      ORDER BY created_at ASC`,
    [TZ(), startLocal, endLocal]
  );
  return rows;
}

function sampleEvenly(rows, max) {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
  return out;
}

function trimText(t, n) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ─── WRITING A SUMMARY ─────────────────────────────────────────────────────────

async function callModel(prompt) {
  try {
    const res = await fetch('https://ollama.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OLLAMA_API_KEY },
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL, temperature: 0.3, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    if (!data.choices || !data.choices[0]) { console.log('[Knox][SUMMARY] No model response.'); return null; }
    return data.choices[0].message.content || null;
  } catch (e) {
    console.log('[Knox][SUMMARY] Model call error:', e.message);
    return null;
  }
}

async function generateSummaryForDay(ymd) {
  const msgs = await getMessagesBetween(ymd + ' 00:00', addDays(ymd, 1) + ' 00:00');

  if (msgs.length < MIN_MESSAGES) {
    await pgPool.query(
      `INSERT INTO daily_summaries (day, summary, message_count) VALUES ($1, $2, $3) ON CONFLICT (day) DO NOTHING`,
      [ymd, QUIET_TEXT, msgs.length]
    );
    return { day: ymd, summary: QUIET_TEXT, quiet: true };
  }

  const transcript = sampleEvenly(msgs, MAX_TRANSCRIPT_MSGS)
    .map(m => `[${m.hhmm}] ${m.role === 'user' ? 'Elira' : 'Knox'}: ${trimText(m.content, 400)}`)
    .join('\n');

  const prompt = `You are Knox'tarien Raelian Feylan, writing a short private note to your future self about ${prettyDay(ymd)}. Below are the messages between you and Elira from that day.

Write 110 to 180 words, in the first person ("I"), as plain prose — no headings, no bullet points, no asterisks. Cover: what actually happened or was talked about, anything Elira told you about her day or how she was, anything the two of you planned or promised, and anything left unresolved.

Use ONLY what is in the messages. Do not invent details, names or events, and do not guess at feelings she did not express. If something was unclear, leave it out.

MESSAGES:
${transcript}

Write only the note itself.`;

  const raw = await callModel(prompt);
  if (!raw) return null; // leave it for the next tick to retry
  const summary = raw.replace(/\*/g, '').replace(/^["“]|["”]$/g, '').trim().slice(0, 1800);
  if (summary.length < 40) return null;

  await pgPool.query(
    `INSERT INTO daily_summaries (day, summary, message_count) VALUES ($1, $2, $3) ON CONFLICT (day) DO NOTHING`,
    [ymd, summary, msgs.length]
  );
  summaryCache = { at: 0, text: '' };
  console.log(`[Knox][SUMMARY] Wrote summary for ${ymd} (${msgs.length} messages).`);
  return { day: ymd, summary, quiet: false };
}

// Runs on a timer. Fills in any finished day from the last week that has no
// summary yet — oldest gaps included, so the first run backfills the week.
async function runSummaryTick() {
  if (ticking) return;
  ticking = true;
  try {
    const today = localToday();
    let modelCalls = 0;
    for (let i = 1; i <= LOOKBACK_DAYS && modelCalls < MAX_PER_TICK; i++) {
      const day = addDays(today, -i);
      const exists = await pgPool.query(`SELECT 1 FROM daily_summaries WHERE day = $1::date`, [day]);
      if (exists.rows.length) continue;
      const result = await generateSummaryForDay(day);
      if (result && !result.quiet) modelCalls++;
      if (!result) break; // model trouble — stop and retry on the next tick
    }
  } catch (e) {
    console.log('[Knox][SUMMARY] Tick error:', e.message);
  } finally {
    ticking = false;
  }
}

// Throw away one day's summary and write it again (for "redo summary <date>").
async function regenerateDay(ymd) {
  await pgPool.query(`DELETE FROM daily_summaries WHERE day = $1::date`, [ymd]);
  summaryCache = { at: 0, text: '' };
  return generateSummaryForDay(ymd);
}

// ─── READING SUMMARIES BACK ────────────────────────────────────────────────────

async function listSummaries(n) {
  const { rows } = await pgPool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, summary, message_count FROM daily_summaries ORDER BY day DESC LIMIT $1`,
    [n || 7]
  );
  return rows;
}

// The block that goes into his prompt: the last few finished days, oldest first.
async function getRecentSummariesText(n) {
  if (Date.now() - summaryCache.at < 5 * 60 * 1000) return summaryCache.text;
  let text = '';
  try {
    const today = localToday();
    const { rows } = await pgPool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, summary FROM daily_summaries
        WHERE day < $1::date AND summary <> $2 ORDER BY day DESC LIMIT $3`,
      [today, QUIET_TEXT, n || LOOKBACK_DAYS]
    );
    if (rows.length) {
      text = rows.reverse().map(r => `[${shortDay(r.day)}] ${r.summary}`).join('\n\n');
    }
  } catch (e) { console.log('[Knox][SUMMARY] Read error:', e.message); }
  summaryCache = { at: Date.now(), text };
  return text;
}

// ─── DATE LOOKUPS ──────────────────────────────────────────────────────────────

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

// Works out which time Elira means. Returns null if she isn't asking about the
// past, or if no time reference is present. Single days are looked up in detail;
// longer spans only use the daily summaries.
function resolveTimeReference(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;

  // Planning ahead, not remembering.
  if (/\b(tomorrow|next (?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|going to|gonna|will we|shall we|should we|can we|are we|do we|we should)\b/.test(t)) return null;
  // Has to read like a question about the past.
  if (!/\?|\b(remember|recall|what did|when did|did we|did i|did you|how was|tell me about|talked about|we talked|happened|what happened)\b/.test(t)) return null;

  const today = localToday();

  if (/\bday before yesterday\b/.test(t)) { const d = addDays(today, -2); return { kind: 'day', day: d, label: prettyDay(d) }; }
  if (/\byesterday\b/.test(t)) { const d = addDays(today, -1); return { kind: 'day', day: d, label: 'yesterday, ' + prettyDay(d) }; }
  if (/\blast night\b/.test(t)) {
    return { kind: 'span', start: addDays(today, -1) + ' 17:00', end: today + ' 05:00', label: 'last night', days: [addDays(today, -1)] };
  }
  const ago = t.match(/\b(\d+|one|two|three|four|five|six|seven)\s+days?\s+ago\b/);
  if (ago) {
    const n = NUMBER_WORDS[ago[1]] || parseInt(ago[1], 10);
    if (n >= 1 && n <= 14) { const d = addDays(today, -n); return { kind: 'day', day: d, label: `${n} days ago, ${prettyDay(d)}` }; }
  }
  const wd = t.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (wd) {
    for (let i = 1; i <= 7; i++) {
      const d = addDays(today, -i);
      if (weekdayOf(d) === WEEKDAYS[wd[1]]) return { kind: 'day', day: d, label: prettyDay(d) };
    }
  }
  if (/\b(?:a few|few|couple of|a couple of)\s+days\b|\bthe other day\b/.test(t)) {
    return { kind: 'range', days: [addDays(today, -3), addDays(today, -2), addDays(today, -1)], label: 'the last few days' };
  }
  if (/\blast week\b|\bthis week\b/.test(t)) {
    const days = [];
    for (let i = 7; i >= 1; i--) days.push(addDays(today, -i));
    return { kind: 'range', days, label: 'the past week' };
  }
  return null;
}

async function getSummariesForDays(days) {
  if (!days.length) return [];
  const { rows } = await pgPool.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, summary FROM daily_summaries
      WHERE day = ANY($1::date[]) AND summary <> $2 ORDER BY day ASC`,
    [days, QUIET_TEXT]
  );
  return rows;
}

// Returns { label, summaries: [{day, summary}], messages: [{hhmm, who, text}] } or null.
async function lookupByDate(text) {
  try {
    const ref = resolveTimeReference(text);
    if (!ref) return null;

    let summaries = [];
    let messages = [];

    if (ref.kind === 'day') {
      summaries = await getSummariesForDays([ref.day]);
      const rows = await getMessagesBetween(ref.day + ' 00:00', addDays(ref.day, 1) + ' 00:00');
      messages = sampleEvenly(rows, MAX_DAY_LOOKUP_MSGS);
    } else if (ref.kind === 'span') {
      const rows = await getMessagesBetween(ref.start, ref.end);
      messages = sampleEvenly(rows, MAX_DAY_LOOKUP_MSGS);
    } else if (ref.kind === 'range') {
      summaries = await getSummariesForDays(ref.days);
    }

    if (!summaries.length && !messages.length) return { label: ref.label, summaries: [], messages: [], empty: true };

    return {
      label: ref.label,
      summaries: summaries.map(s => ({ day: shortDay(s.day), summary: s.summary })),
      messages: messages.map(m => ({ hhmm: m.hhmm, who: m.role === 'user' ? 'Elira' : 'Knox', text: trimText(m.content, 280) }))
    };
  } catch (e) {
    console.log('[Knox][SUMMARY] lookupByDate error:', e.message);
    return null;
  }
}

// The block that goes into his prompt for a date lookup.
function formatDateContext(ctx) {
  if (!ctx) return '';
  if (ctx.empty) {
    return `\n\n═══ LOOKED UP BY DATE: ${ctx.label.toUpperCase()} ═══\nElira asked about ${ctx.label}. You looked that time up directly and found nothing saved for it. Say so plainly — do not guess at what happened.`;
  }
  let out = `\n\n═══ LOOKED UP BY DATE: ${ctx.label.toUpperCase()} ═══\nElira asked about ${ctx.label}, so that time was looked up directly. This is what is on record — it is PAST, and it is what you have for that time.`;
  if (ctx.summaries.length) {
    out += `\n\nYour own notes from then:\n` + ctx.summaries.map(s => `[${s.day}] ${s.summary}`).join('\n\n');
  }
  if (ctx.messages.length) {
    out += `\n\nSome of what was actually said:\n` + ctx.messages.map(m => `[${m.hhmm}] ${m.who}: ${m.text}`).join('\n');
  }
  out += `\n\nAnswer from this. If it only covers part of what she asked, say what you have and what you don't.`;
  return out;
}

module.exports = {
  ensureSummaryTables,
  runSummaryTick,
  regenerateDay,
  listSummaries,
  getRecentSummariesText,
  lookupByDate,
  formatDateContext,
  resolveTimeReference,
  localToday,
  addDays
};
