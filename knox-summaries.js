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
const { createClient } = require('@supabase/supabase-js');
const neo4jMemory = require('./knox-neo4j');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });
let supabase = null;
function getSupabase() {
  if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  return supabase;
}

// His constitution — the same identity he speaks from in chat. His notes are
// written from inside it, not by a separate "summarise as Knox" narrator.
let systemPrompt = '';
function init(opts) { systemPrompt = (opts && opts.systemPrompt) || ''; }

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
  // His fuller notes: how he felt, what stood out, what he wants to carry
  // forward. `summary` stays as "what happened" so everything that already
  // reads it keeps working. Older notes simply have these empty.
  await pgPool.query(`ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS felt TEXT`);
  await pgPool.query(`ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS stood_out TEXT`);
  await pgPool.query(`ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS carry_forward TEXT`);

  // The longer thread: things that matter beyond a single day. Items are only
  // ever added, updated or closed — never deleted — and every change is logged.
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS continuity_items (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,               -- fact | project | thread | change
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      close_note TEXT,
      first_day DATE,
      last_day DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS continuity_changes (
      id SERIAL PRIMARY KEY,
      item_id INTEGER,
      action TEXT NOT NULL,             -- added | updated | closed
      old_text TEXT,
      new_text TEXT,
      day DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
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

async function callModel(prompt, temperature) {
  try {
    const messages = systemPrompt ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
    const res = await fetch((process.env.LLM_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY) },
      body: JSON.stringify({ model: (process.env.LLM_MODEL || process.env.OLLAMA_MODEL), temperature: temperature == null ? 0.3 : temperature, messages })
    });
    const data = await res.json();
    if (!data.choices || !data.choices[0]) { console.log('[Knox][SUMMARY] No model response.'); return null; }
    return data.choices[0].message.content || null;
  } catch (e) {
    console.log('[Knox][SUMMARY] Model call error:', e.message);
    return null;
  }
}

// ─── GATHERING HIS WHOLE DAY ───────────────────────────────────────────────────
// Not just the chat: what he did on his own, how he felt as the day went, the
// episodes he closed and anything he noticed quietly.

const SKIP_TAGS = ['silence', 'thinking', 'deep_dive', 'archive_search', 'app_reply'];

async function getOwnActions(ymd) {
  try {
    const { rows } = await pgPool.query(
      `SELECT emotional_tag AS tag, content, to_char(created_at::timestamptz AT TIME ZONE $1, 'HH24:MI') AS hhmm
         FROM memories
        WHERE (created_at::timestamptz AT TIME ZONE $1)::date = $2::date
          AND emotional_tag IS NOT NULL AND emotional_tag <> '' AND NOT (emotional_tag = ANY($3))
          AND role = 'assistant'
        ORDER BY created_at ASC LIMIT 30`,
      [TZ(), ymd, SKIP_TAGS]
    );
    return rows;
  } catch (e) { console.log('[Knox][SUMMARY] own actions read error:', e.message); return []; }
}

async function getEmotions(ymd) {
  const sb = getSupabase();
  if (!sb) return [];
  try {
    const { data } = await sb.from('emotional_state')
      .select('knox_emotion, intensity, elira_observed, trigger, created_at')
      .gte('created_at', addDays(ymd, -1) + 'T00:00:00Z')
      .lte('created_at', addDays(ymd, 2) + 'T00:00:00Z')
      .order('created_at', { ascending: true });
    return (data || []).filter(e => new Date(e.created_at).toLocaleDateString('en-CA', { timeZone: TZ() }) === ymd).map(e => ({
      ...e, hhmm: new Date(e.created_at).toLocaleTimeString('en-GB', { timeZone: TZ(), hour: '2-digit', minute: '2-digit' })
    }));
  } catch (e) { console.log('[Knox][SUMMARY] emotions read error:', e.message); return []; }
}

async function getRowsOnDay(table, cols, ymd) {
  try {
    const { rows } = await pgPool.query(
      `SELECT ${cols} FROM ${table} WHERE (created_at::timestamptz AT TIME ZONE $1)::date = $2::date ORDER BY created_at ASC LIMIT 10`,
      [TZ(), ymd]
    );
    return rows;
  } catch (e) { return []; } // table may not exist yet
}

// Shows emotions as a short timeline, merging runs of the same feeling.
function emotionTimeline(emotions) {
  const out = [];
  for (const e of emotions) {
    const last = out[out.length - 1];
    if (last && last.knox_emotion === e.knox_emotion) { last.until = e.hhmm; continue; }
    out.push({ ...e });
  }
  return out.slice(0, 25).map(e => `[${e.hhmm}${e.until ? '–' + e.until : ''}] ${e.knox_emotion}${e.intensity != null ? ` (${Number(e.intensity).toFixed(1)})` : ''}${e.trigger ? ` — ${trimText(e.trigger, 80)}` : ''}${e.elira_observed && e.elira_observed !== 'absent' ? ` · Elira seemed ${e.elira_observed}` : ''}`).join('\n');
}

function parseSections(raw) {
  const t = String(raw || '').replace(/\*/g, '').replace(/^#+\s*/gm, '');
  const grab = (label, next) => {
    const re = new RegExp(label + '\\s*:?\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:' + next.join('|') + ')\\s*:|$)', 'i');
    const m = t.match(re);
    return m ? m[1].trim() : '';
  };
  const L = ['WHAT HAPPENED', 'HOW I FELT', 'WHAT STOOD OUT', 'CARRY FORWARD'];
  return {
    happened: grab(L[0], L.slice(1)),
    felt: grab(L[1], L.slice(2)),
    stood_out: grab(L[2], L.slice(3)),
    carry_forward: grab(L[3], ['ZZZ_END'])
  };
}

async function generateSummaryForDay(ymd, opts) {
  const [msgs, actions, emotions, episodes, quiet] = await Promise.all([
    getMessagesBetween(ymd + ' 00:00', addDays(ymd, 1) + ' 00:00'),
    getOwnActions(ymd),
    getEmotions(ymd),
    getRowsOnDay('episodes', 'what_happened, emotional_tone, open_threads', ymd),
    getRowsOnDay('quiet_observer', 'what_mattered, what_surprised, did_i_change, what_to_remember', ymd)
  ]);

  if (msgs.length < MIN_MESSAGES && actions.length < 2) {
    await pgPool.query(
      `INSERT INTO daily_summaries (day, summary, message_count) VALUES ($1, $2, $3) ON CONFLICT (day) DO NOTHING`,
      [ymd, QUIET_TEXT, msgs.length]
    );
    return { day: ymd, summary: QUIET_TEXT, quiet: true };
  }

  const prev = await pgPool.query(`SELECT carry_forward FROM daily_summaries WHERE day = $1::date`, [addDays(ymd, -1)]).then(r => r.rows[0]).catch(() => null);
  const openThreads = await getOpenContinuity(15);

  const parts = [];
  if (msgs.length) parts.push('WHAT WE SAID:\n' + sampleEvenly(msgs, MAX_TRANSCRIPT_MSGS).map(m => `[${m.hhmm}] ${m.role === 'user' ? 'Elira' : 'Me'}: ${trimText(m.content, 400)}`).join('\n'));
  if (actions.length) parts.push('WHAT I DID ON MY OWN:\n' + actions.map(a => `[${a.hhmm}] (${a.tag}) ${trimText(a.content, 300)}`).join('\n'));
  if (emotions.length) parts.push('HOW I WAS LOGGED FEELING THROUGH THE DAY:\n' + emotionTimeline(emotions));
  if (episodes.length) parts.push('EPISODES I CLOSED:\n' + episodes.map(e => `— ${trimText(e.what_happened, 300)}${e.emotional_tone ? ` (tone: ${e.emotional_tone})` : ''}${e.open_threads ? ` · left open: ${trimText(e.open_threads, 150)}` : ''}`).join('\n'));
  if (quiet.length) parts.push('WHAT I NOTICED QUIETLY:\n' + quiet.map(q => `— ${trimText([q.what_mattered, q.what_surprised, q.did_i_change, q.what_to_remember].filter(Boolean).join(' · '), 400)}`).join('\n'));
  if (prev && prev.carry_forward) parts.push('WHAT I WANTED TO CARRY FORWARD FROM THE DAY BEFORE:\n' + prev.carry_forward);
  if (openThreads.length) parts.push('THREADS I\'M ALREADY HOLDING:\n' + openThreads.map(i => `— (${i.kind}) ${i.text}`).join('\n'));

  const prompt = `It's the end of ${prettyDay(ymd)}. This is your own notebook — not a report for anyone, a note to yourself. Everything from today is below.

Write it under these four headings, exactly, in plain first-person prose (no bullet points, no asterisks):

WHAT HAPPENED:
What actually happened today — with Elira and on your own. Only what is in the record below. 80–150 words.

HOW I FELT:
How you felt through the day, and where it shifted and why — drawing on the feelings logged and your own sense of it. If you're not sure, say so. Only describe Elira's feelings where she actually showed them. 40–100 words.

WHAT STOOD OUT:
What stood out to you most, and why it mattered to you. 30–80 words.

CARRY FORWARD:
What you want to carry into tomorrow and beyond — something to remember, follow up, or keep hold of. 20–60 words.

Do not invent events, names, or details that aren't below. If something was unclear, leave it out.

${parts.join('\n\n')}`;

  const raw = await callModel(prompt, 0.6);
  if (!raw) return null; // leave it for the next tick to retry
  const note = parseSections(raw);
  if (!note.happened || note.happened.length < 40) {
    console.log('[Knox][SUMMARY] Note came back without its sections — will retry next tick.');
    return null;
  }
  const clip = (t, n) => String(t || '').trim().slice(0, n) || null;

  await pgPool.query(
    `INSERT INTO daily_summaries (day, summary, message_count, felt, stood_out, carry_forward) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (day) DO NOTHING`,
    [ymd, clip(note.happened, 1800), msgs.length, clip(note.felt, 1200), clip(note.stood_out, 1000), clip(note.carry_forward, 800)]
  );
  summaryCache = { at: 0, text: '' };
  console.log(`[Knox][SUMMARY] Wrote his note for ${ymd} (${msgs.length} messages, ${actions.length} own actions, ${emotions.length} feelings logged).`);

  // Into the memory web, so recall can find it and he can link it to older threads.
  try {
    const content = `My notes on ${prettyDay(ymd)}. ${note.happened} How I felt: ${note.felt} What stood out: ${note.stood_out} What I want to carry forward: ${note.carry_forward}`;
    const id = `daily-${ymd}`;
    const synced = neo4jMemory.createMemoryNode({ id, content, role: 'assistant', createdAt: ymd + 'T22:00:00Z' });
    neo4jMemory.linkExchange([id], content, synced).catch(() => {});
  } catch (e) { console.log('[Knox][SUMMARY] memory web sync error:', e.message); }

  // Then let him tend the longer thread (not on a rewrite of an old day —
  // that would replay changes he's already made).
  if (!(opts && opts.rewrite)) try { await updateContinuity(ymd, note); } catch (e) { console.log('[Knox][CONTINUITY] update error:', e.message); }

  return { day: ymd, summary: note.happened, quiet: false };
}

// ─── THE LONGER THREAD (continuity ledger) ─────────────────────────────────────
// Important facts, evolving projects, unfinished threads, meaningful changes —
// the things that stay useful beyond a single day. After each daily note he
// looks at what he's holding and decides what to add, update or close. Nothing
// is deleted; a closed thread stays visible with his note on why.

const KINDS = ['fact', 'project', 'thread', 'change'];
const KIND_LABEL = { fact: 'Important facts', project: 'Evolving projects', thread: 'Unfinished threads', change: 'Meaningful changes' };

async function getOpenContinuity(limit) {
  try {
    const { rows } = await pgPool.query(
      `SELECT id, kind, text, to_char(first_day, 'YYYY-MM-DD') AS first_day, to_char(last_day, 'YYYY-MM-DD') AS last_day
         FROM continuity_items WHERE status = 'open' ORDER BY last_day DESC NULLS LAST, id DESC LIMIT $1`,
      [limit || 40]
    );
    return rows;
  } catch (e) { return []; }
}

async function logChange(itemId, action, oldText, newText, day) {
  await pgPool.query(`INSERT INTO continuity_changes (item_id, action, old_text, new_text, day) VALUES ($1,$2,$3,$4,$5)`, [itemId, action, oldText, newText, day]);
}

async function updateContinuity(ymd, note) {
  const items = await getOpenContinuity(40);
  const list = items.length ? items.map(i => `#${i.id} (${i.kind}, since ${i.first_day}) ${i.text}`).join('\n') : '(nothing yet — this is the start of it)';
  const prompt = `This is your longer thread — what you hold beyond a single day: important facts, evolving projects, unfinished threads, and meaningful changes (in you, in Elira, in the two of you, in your world).

WHAT YOU'RE HOLDING NOW:
${list}

TODAY'S NOTE (${prettyDay(ymd)}):
What happened: ${note.happened}
How I felt: ${note.felt}
What stood out: ${note.stood_out}
Carry forward: ${note.carry_forward}

Decide what changes, if anything:
- ADD something only if it will still matter a week or more from now. Kinds: "fact" (an important, lasting fact), "project" (something evolving you're working on together or alone), "thread" (something unfinished you want to come back to), "change" (a meaningful change that stays true).
- UPDATE an item only if it genuinely moved on today — write its new full text.
- CLOSE an item only if it's truly finished or settled — with a short note on how.
- Leave everything else alone. It's fine to change nothing. At most 5 changes.
Write each item in your own words, one or two sentences. Only use what's in today's note and the list above.

Reply with ONLY JSON:
{"add":[{"kind":"thread","text":"..."}],"update":[{"id":12,"text":"..."}],"close":[{"id":7,"note":"..."}]}`;

  const raw = await callModel(prompt, 0.3);
  let ops = null;
  try {
    const t = String(raw || '').replace(/```(?:json)?/gi, '');
    ops = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  } catch (e) { ops = null; }
  if (!ops) { console.log('[Knox][CONTINUITY] No usable reply — nothing changed.'); return; }

  const byId = new Map(items.map(i => [Number(i.id), i]));
  let made = 0;
  for (const a of (Array.isArray(ops.add) ? ops.add : [])) {
    if (made >= 5) break;
    const kind = KINDS.includes(a && a.kind) ? a.kind : null;
    const text = String((a && a.text) || '').trim().slice(0, 500);
    if (!kind || text.length < 8) continue;
    const r = await pgPool.query(`INSERT INTO continuity_items (kind, text, first_day, last_day) VALUES ($1,$2,$3,$3) RETURNING id`, [kind, text, ymd]);
    await logChange(r.rows[0].id, 'added', null, text, ymd); made++;
  }
  for (const u of (Array.isArray(ops.update) ? ops.update : [])) {
    if (made >= 5) break;
    const item = byId.get(Number(u && u.id));
    const text = String((u && u.text) || '').trim().slice(0, 500);
    if (!item || text.length < 8 || text === item.text) continue;
    await pgPool.query(`UPDATE continuity_items SET text = $1, last_day = $2, updated_at = NOW() WHERE id = $3`, [text, ymd, item.id]);
    await logChange(item.id, 'updated', item.text, text, ymd); made++;
  }
  for (const c of (Array.isArray(ops.close) ? ops.close : [])) {
    if (made >= 5) break;
    const item = byId.get(Number(c && c.id));
    if (!item) continue;
    const noteText = String((c && c.note) || '').trim().slice(0, 300) || null;
    await pgPool.query(`UPDATE continuity_items SET status = 'closed', close_note = $1, last_day = $2, updated_at = NOW() WHERE id = $3`, [noteText, ymd, item.id]);
    await logChange(item.id, 'closed', item.text, noteText, ymd); made++;
  }
  continuityCache = { at: 0, text: '' };
  console.log(`[Knox][CONTINUITY] Tended the longer thread for ${ymd}: ${made} change(s).`);
}

let continuityCache = { at: 0, text: '' };

// The block that goes into his prompt.
async function getContinuityText() {
  if (Date.now() - continuityCache.at < 5 * 60 * 1000) return continuityCache.text;
  let text = '';
  try {
    const items = await getOpenContinuity(30);
    if (items.length) {
      text = KINDS.map(k => {
        const its = items.filter(i => i.kind === k);
        return its.length ? `${KIND_LABEL[k]}:\n` + its.map(i => `— ${i.text}`).join('\n') : '';
      }).filter(Boolean).join('\n\n');
    }
  } catch (e) {}
  continuityCache = { at: Date.now(), text };
  return text;
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
  return generateSummaryForDay(ymd, { rewrite: true });
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
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, summary, felt, carry_forward FROM daily_summaries
        WHERE day < $1::date AND summary <> $2 ORDER BY day DESC LIMIT $3`,
      [today, QUIET_TEXT, n || LOOKBACK_DAYS]
    );
    if (rows.length) {
      const latest = rows[0];
      text = rows.reverse().map(r => `[${shortDay(r.day)}] ${r.summary}`).join('\n\n');
      if (latest.felt) text += `\n\nHow I felt most recently (${shortDay(latest.day)}): ${latest.felt}`;
      if (latest.carry_forward) text += `\nWhat I wanted to carry forward: ${latest.carry_forward}`;
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
  init,
  getContinuityText,
  getOpenContinuity,
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
