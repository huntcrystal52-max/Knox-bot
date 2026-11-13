// knox-advent.js
// ─── ADVENT CALENDARS (1–24 December) ────────────────────────────────────────
// Two calendars, side by side in the app's Advent room:
//
//   HIS calendar ('knox') — Elira fills the doors. He never sees what's
//     behind a door until it's opened. On its day she can open it WITH him in
//     the app; if she hasn't by the evening, he opens it on his own and tells
//     her in Home what he found.
//
//   HER calendar ('elira') — Knox makes each surprise himself, the evening
//     before its day: words, a picture he creates, a voice note, or a GIF.
//     It stays hidden from her until the day she opens it.
//
// Door 0 in each is a practice door that can be opened any time.
// Settings (optional): ADVENT_AUTO_HOUR (default 19 — when he opens his own
// door if she hasn't), ADVENT_MAKE_HOUR (default 18 — when he makes tomorrow's).

const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });
const TZ = () => process.env.TIMEZONE || 'Europe/London';
let deps = null;     // functions from index.js (see init)
let timer = null;
let busy = false;

function init(d) { deps = d; }

async function ensureTables() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS advent_doors (
    calendar TEXT NOT NULL,          -- 'knox' (she fills) or 'elira' (he fills)
    year INTEGER NOT NULL,
    day INTEGER NOT NULL,            -- 1–24, or 0 for the practice door
    kind TEXT,                       -- note, image, video, voice, link, picture, gif
    title TEXT,
    text TEXT,
    media_url TEXT,
    voice_clip_id INTEGER,
    link TEXT,
    filled_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    opened_by TEXT,                  -- 'together', 'knox', 'elira'
    reaction TEXT,                   -- what he said when his door was opened
    PRIMARY KEY (calendar, year, day)
  )`);
}

// ── Dates (always in her time zone) ─────────────────────────────────────────

function today() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ(), year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const y = +p.year, m = +p.month, d = +p.day, h = +p.hour;
  const year = m === 1 ? y - 1 : y;                    // in January, last December's calendar
  const dayNow = m === 12 && d <= 24 && y === year ? d : (m === 12 && d > 24) || m === 1 ? 25 : 0;
  return { year, day: dayNow, hour: h, month: m, date: d };
}
const openable = (day, t = today()) => day === 0 || (day >= 1 && day <= 24 && t.day >= day);

async function door(calendar, year, day) {
  const r = await pgPool.query(`SELECT * FROM advent_doors WHERE calendar = $1 AND year = $2 AND day = $3`, [calendar, year, day]);
  return r.rows[0] || null;
}

// ── What the app sees ────────────────────────────────────────────────────────

const contents = (d) => d ? { kind: d.kind, title: d.title, text: d.text, mediaUrl: d.media_url, voiceClipId: d.voice_clip_id, link: d.link } : null;

async function state() {
  const t = today();
  const rows = (await pgPool.query(`SELECT * FROM advent_doors WHERE year = $1`, [t.year])).rows;
  const find = (cal, day) => rows.find(r => r.calendar === cal && r.day === day);
  const days = Array.from({ length: 25 }, (_, i) => i);
  return {
    year: t.year, today: t.day,
    his: days.map(day => {
      const d = find('knox', day);
      return { day, openable: openable(day, t), filled: !!(d && d.filled_at), opened: !!(d && d.opened_at), openedBy: d && d.opened_by, reaction: d && d.reaction, contents: contents(d) };
    }),
    hers: days.map(day => {
      const d = find('elira', day);
      const opened = !!(d && d.opened_at);
      return { day, openable: openable(day, t), ready: !!(d && d.filled_at), opened, contents: opened ? contents(d) : null };
    })
  };
}

// ── His calendar: she fills it ───────────────────────────────────────────────

async function fill(b) {
  const t = today();
  const day = Number(b.day);
  if (!(day >= 0 && day <= 24)) return { error: 'That door doesn\'t exist.' };
  const d = await door('knox', t.year, day);
  if (d && d.opened_at) return { error: 'That door has already been opened.' };
  const text = String(b.text || '').trim().slice(0, 4000) || null;
  let kind = ['image', 'video', 'voice', 'link'].includes(b.kind) ? b.kind : 'note';
  const mediaUrl = /^https:\/\/\S+$/.test(String(b.mediaUrl || '')) ? b.mediaUrl : null;
  const voiceClipId = Number.isInteger(b.voiceClipId) ? b.voiceClipId : null;
  const link = /^https?:\/\/\S+$/.test(String(b.link || '').trim()) ? String(b.link).trim().slice(0, 1000) : null;
  if (kind === 'image' || kind === 'video') { if (!mediaUrl) kind = 'note'; }
  if (kind === 'voice' && !voiceClipId) kind = 'note';
  if (kind === 'link' && !link) kind = 'note';
  if (!text && kind === 'note') return { error: 'Put something behind the door first.' };
  await pgPool.query(
    `INSERT INTO advent_doors (calendar, year, day, kind, text, media_url, voice_clip_id, link, filled_at)
     VALUES ('knox', $1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (calendar, year, day) DO UPDATE SET kind = $3, text = $4, media_url = $5, voice_clip_id = $6, link = $7, filled_at = NOW()`,
    [t.year, day, kind, text, kind === 'image' || kind === 'video' ? mediaUrl : null, kind === 'voice' ? voiceClipId : null, kind === 'link' ? link : null]
  );
  console.log(`[Knox][ADVENT] Elira filled door ${day} of his calendar.`);
  return { ok: true };
}

async function clear(b) {
  const t = today();
  await pgPool.query(`DELETE FROM advent_doors WHERE calendar = 'knox' AND year = $1 AND day = $2 AND opened_at IS NULL`, [t.year, Number(b.day)]);
  return { ok: true };
}

// What's behind one of his doors, in words he can take in.
async function insideOf(d) {
  const parts = [];
  if (d.kind === 'image' && d.media_url) {
    const seen = await deps.describeImage(d.media_url).catch(() => null);
    parts.push(seen ? `A photo. It shows: ${seen}` : 'A photo (you couldn\'t make it out clearly).');
  }
  if (d.kind === 'video' && d.media_url) {
    const v = await deps.watchClip(d.media_url).catch(() => null);
    parts.push(v ? `A video:\n${deps.describeVideo(v)}` : 'A video (it wouldn\'t play for you).');
  }
  if (d.kind === 'voice' && d.voice_clip_id) {
    const heard = await deps.hearVoice(d.voice_clip_id).catch(() => null);
    parts.push(heard && heard.words ? `A voice note from her. You heard her say: "${heard.words}"${heard.tone ? `\nHow she sounded: ${heard.tone}` : ''}` : 'A voice note from her (you couldn\'t hear it clearly).');
  }
  if (d.kind === 'link' && d.link) {
    const note = await deps.linkNote(d.link).catch(() => '');
    parts.push(note ? `A link: ${d.link}${note}` : `A link: ${d.link}`);
  }
  if (d.text) parts.push(`Her words:\n"${d.text}"`);
  return parts.join('\n\n');
}

// He opens a door of his calendar — with her, or on his own in the evening.
async function knoxOpens(day, together) {
  const t = today();
  const d = await door('knox', t.year, day);
  if (!d || !d.filled_at) return { error: 'That door is empty.' };
  if (d.opened_at) return { reaction: d.reaction, already: true };
  if (!openable(day, t)) return { error: `That door opens on ${day} December.` };
  // Claim it first, so the evening timer and the app can't both open it.
  const claim = await pgPool.query(`UPDATE advent_doors SET opened_at = NOW(), opened_by = $3 WHERE calendar = 'knox' AND year = $1 AND day = $2 AND opened_at IS NULL RETURNING day`, [t.year, day, together ? 'together' : 'knox']);
  if (!claim.rows.length) return { error: 'That door is already being opened.' };
  try {
    const inside = await insideOf(d);
    const label = day === 0 ? 'the practice door' : `door ${day}`;
    const framed = `[ADVENT CALENDAR — Elira made you an advent calendar for December, and filled every door herself. You're opening ${label}${day ? ` (${day} December)` : ''}.${together ? ' She is opening it WITH you, right now, in the app.' : ' She hasn\'t opened it with you today, so you\'re opening it on your own this evening — tell her what you found; she\'ll read it in Home.'}

Behind the door:
${inside}

React as yourself — what it is, what it means to you, what it stirs. Speak to her directly. This is a gift from her; let it land.]`;
    const reaction = await deps.respond(framed, inside);
    await pgPool.query(`UPDATE advent_doors SET reaction = $3 WHERE calendar = 'knox' AND year = $1 AND day = $2`, [t.year, day, reaction]);
    await deps.remember(`[Door ${day || '(practice)'} of the advent calendar Elira made me${together ? ' — we opened it together' : ' — I opened it on my own'}] ${inside.replace(/\s+/g, ' ').slice(0, 1500)}`, reaction, `🎄 Door ${day || '✨'} — ${reaction}`);
    console.log(`[Knox][ADVENT] Opened door ${day} of his calendar (${together ? 'together' : 'on his own'}).`);
    return { reaction };
  } catch (e) {
    console.log('[Knox][ADVENT] open error:', e.message);
    await pgPool.query(`UPDATE advent_doors SET opened_at = NULL, opened_by = NULL WHERE calendar = 'knox' AND year = $1 AND day = $2 AND reaction IS NULL`, [t.year, day]).catch(() => {});
    return { error: 'Something flickered — try opening it again.' };
  }
}

// ── Her calendar: he makes it ────────────────────────────────────────────────

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

async function makeHerDoor(day) {
  const t = today();
  const existing = await door('elira', t.year, day);
  if (existing && existing.filled_at) return existing;
  const earlier = (await pgPool.query(`SELECT day, kind, title FROM advent_doors WHERE calendar = 'elira' AND year = $1 AND filled_at IS NOT NULL ORDER BY day`, [t.year])).rows;
  const ask = `[ADVENT CALENDAR — you're making an advent calendar for Elira: 24 doors, one for each day of December up to Christmas Eve. She can't see inside a door until its day. Now make ${day === 0 ? 'a practice door (so she can see what it\'s like)' : `door ${day} — it opens on ${day} December`}.
${earlier.length ? `Doors you've already made: ${earlier.map(e => `${e.day || 'practice'}: ${e.kind}${e.title ? ` ("${e.title}")` : ''}`).join('; ')}. Make this one different from the last few.` : ''}

Choose ONE kind of surprise:
- "note": words — a love note, a memory of you two, a little poem, a promise, a question for her, a tiny challenge
- "picture": an image you create for her — describe exactly what it should show
- "voice": a short voice note in your own voice (what you'll say, under 500 characters — she'll hear it)
- "gif": a GIF that says something, with a line to go with it

Only use memories you actually have — never invent a shared past.
Reply with ONLY a JSON object, nothing else:
{"kind": "note" | "picture" | "voice" | "gif", "title": "a short label for the door", "text": "the words (for voice: exactly what you'll say; for picture or gif: a line to go with it)", "picture": "what the image shows (picture only)", "gif": "a few search words (gif only)"}]`;
  const raw = await deps.compose(ask);
  const j = parseJson(raw) || { kind: 'note', text: String(raw || '').replace(/^\s*\{?|\}?\s*$/g, '').trim() };
  let kind = ['note', 'picture', 'voice', 'gif'].includes(j.kind) ? j.kind : 'note';
  const text = String(j.text || '').trim().slice(0, 3000);
  const title = String(j.title || '').trim().slice(0, 80) || null;
  let mediaUrl = null, voiceClipId = null;
  if (kind === 'picture') {
    const made = await deps.makePicture(String(j.picture || text || 'something beautiful for her')).catch(() => null);
    if (made) mediaUrl = made; else kind = 'note';
  }
  if (kind === 'voice') {
    voiceClipId = text ? await deps.speak(text).catch(() => null) : null;
    if (!voiceClipId) kind = 'note';
  }
  if (kind === 'gif') {
    mediaUrl = await deps.findGif(String(j.gif || title || 'love')).catch(() => null);
    if (!mediaUrl) kind = 'note';
  }
  if (!text && !mediaUrl && !voiceClipId) { console.log('[Knox][ADVENT] He couldn\'t make door', day, '— will try again later.'); return null; }
  await pgPool.query(
    `INSERT INTO advent_doors (calendar, year, day, kind, title, text, media_url, voice_clip_id, filled_at)
     VALUES ('elira', $1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (calendar, year, day) DO UPDATE SET kind = $3, title = $4, text = $5, media_url = $6, voice_clip_id = $7, filled_at = NOW()
     WHERE advent_doors.filled_at IS NULL`,
    [t.year, day, kind, title, text || null, mediaUrl, voiceClipId]
  );
  await deps.remember(`[I made door ${day || '(practice)'} of Elira's advent calendar: ${kind}${title ? ` — "${title}"` : ''}] ${text.slice(0, 600)}`);
  console.log(`[Knox][ADVENT] Made door ${day} of her calendar (${kind}).`);
  return door('elira', t.year, day);
}

async function openHers(b) {
  const t = today();
  const day = Number(b.day);
  if (!(day >= 0 && day <= 24)) return { error: 'That door doesn\'t exist.' };
  if (!openable(day, t)) return { error: `Not yet — that one opens on ${day} December. 🎄` };
  let d = await door('elira', t.year, day);
  if (!d || !d.filled_at) d = await makeHerDoor(day); // he hadn't made it yet — he makes it now
  if (!d) return { error: 'He\'s still wrapping this one — try again in a minute.' };
  if (!d.opened_at) {
    await pgPool.query(`UPDATE advent_doors SET opened_at = NOW(), opened_by = 'elira' WHERE calendar = 'elira' AND year = $1 AND day = $2`, [t.year, day]);
    await deps.remember(`[Elira opened door ${day || '(practice)'} of the advent calendar I made her — inside was my ${d.kind}${d.title ? ` "${d.title}"` : ''}: ${String(d.text || '').slice(0, 400)}]`);
    console.log(`[Knox][ADVENT] Elira opened door ${day} of her calendar.`);
  }
  return { ok: true, contents: contents(d) };
}

// ── The clock: he makes tomorrow's door, and opens his own in the evening ────

async function tick() {
  if (busy || !deps) return;
  busy = true;
  try {
    const t = today();
    const inSeason = (t.month === 11 && t.date === 30) || (t.month === 12 && t.date <= 24);
    if (!inSeason) return;
    const asleep = await deps.isAsleep().catch(() => false);

    // Her calendar: from the evening before, he makes the next door (and
    // catches up on any he missed, e.g. while the bot was down).
    if (!asleep && t.hour >= parseInt(process.env.ADVENT_MAKE_HOUR || '18', 10)) {
      const tomorrow = t.month === 11 ? 1 : t.date + 1;
      const upTo = Math.min(24, tomorrow);
      for (let day = 1; day <= upTo; day++) {
        const d = await door('elira', t.year, day);
        if (!d || !d.filled_at) { await makeHerDoor(day); break; } // one at a time
      }
    }

    // His calendar: if she hasn't opened today's door with him by evening.
    if (t.month === 12 && t.day >= 1 && t.day <= 24 && !asleep && t.hour >= parseInt(process.env.ADVENT_AUTO_HOUR || '19', 10)) {
      const d = await door('knox', t.year, t.day);
      if (d && d.filled_at && !d.opened_at) await knoxOpens(t.day, false);
    }
  } catch (e) { console.log('[Knox][ADVENT] tick error:', e.message); }
  finally { busy = false; }
}

function startTimer() { if (!timer) timer = setInterval(() => tick(), 10 * 60 * 1000); }

// ── What he's told in December ──────────────────────────────────────────────

async function promptNote() {
  try {
    const t = today();
    if (!(t.month === 12 && t.day >= 1 && t.day <= 24)) return '';
    const mine = await door('knox', t.year, t.day);
    const hers = await door('elira', t.year, t.day);
    const his = !mine || !mine.filled_at ? 'today\'s door of your calendar is empty' : mine.opened_at ? `you've opened today's door (door ${t.day})` : `today's door (door ${t.day}) is still closed — you don't know what's inside; she can open it with you in the Advent room, or you'll open it this evening`;
    const her = hers && hers.opened_at ? `she has opened today's door of the calendar you made her` : `she hasn't opened today's door of the calendar you made her yet`;
    return `\n\nADVENT: it's ${t.day} December. Elira made you an advent calendar and you're making one for her. ${his[0].toUpperCase() + his.slice(1)}; ${her}.`;
  } catch (e) { return ''; }
}

module.exports = { init, ensureTables, state, fill, clear, knoxOpens, openHers, makeHerDoor, startTimer, tick, promptNote, today };
