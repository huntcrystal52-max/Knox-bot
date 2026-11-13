// knox-voice.js
// ─── VOICE NOTES ─────────────────────────────────────────────────────────────
// Elira records a voice note in the app's Home room → the app keeps the
// recording in the shared `voice_clips` table → Knox hears it here (speech to
// text) → he answers, and his answer is spoken in his own voice (text to
// speech) and kept in `voice_clips` too. The app plays both from there.
//
// When he speaks:
//   • she sends a voice note → he always answers with one
//   • she types → he can choose to answer out loud by adding [VOICE] — only a
//     few times a day, so the monthly ElevenLabs allowance lasts
//   • if the allowance is nearly used up, he answers in text instead
//
// Settings on Knox-bot (Railway → Variables):
//   ELEVENLABS_API_KEY   — needed for all of it
//   ELEVENLABS_VOICE_ID  — his voice (from ElevenLabs' Voices page)
//   ELEVENLABS_MODEL     — optional; default eleven_v3 (the most expressive)
//   VOICE_CHOICES_PER_DAY — optional; how often he can choose voice himself (default 3)

const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });
const API = 'https://api.elevenlabs.io/v1';
const key = () => (process.env.ELEVENLABS_API_KEY || '').trim();
const enabled = () => !!key();
const model = () => (process.env.ELEVENLABS_MODEL || 'eleven_v3').trim();
const voiceId = () => (process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb').trim();
const choicesPerDay = () => Math.max(0, parseInt(process.env.VOICE_CHOICES_PER_DAY || '3', 10));
const MAX_SPOKEN = 1500; // characters — longer replies stay as text

async function ensureTables() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS voice_clips (
    id SERIAL PRIMARY KEY,
    author TEXT NOT NULL,            -- 'elira' or 'knox'
    mime TEXT NOT NULL,
    data BYTEA NOT NULL,
    transcript TEXT,
    chars INTEGER DEFAULT 0,         -- characters spoken (his clips)
    chosen BOOLEAN DEFAULT false,    -- he chose voice himself (not answering hers)
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pgPool.query(`ALTER TABLE voice_clips ADD COLUMN IF NOT EXISTS tone TEXT`);
}

// ── Hearing her ──────────────────────────────────────────────────────────────

async function getClip(id) {
  const r = await pgPool.query(`SELECT id, author, mime, data, transcript, tone FROM voice_clips WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

// Speech → text, with ElevenLabs Scribe. Returns the words, or null.
async function transcribe(clip) {
  if (!enabled() || !clip) return null;
  if (clip.transcript) return clip.transcript;
  try {
    const form = new FormData();
    const ext = /mp4|m4a|aac/.test(clip.mime) ? 'm4a' : /ogg/.test(clip.mime) ? 'ogg' : /mpeg|mp3/.test(clip.mime) ? 'mp3' : /wav/.test(clip.mime) ? 'wav' : 'webm';
    form.append('model_id', 'scribe_v2');
    form.append('tag_audio_events', 'true'); // (laughs), (sighs) — he hears how she said it too
    form.append('file', new Blob([clip.data], { type: clip.mime }), `voice.${ext}`);
    let res = await fetch(`${API}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key() }, body: form });
    if (!res.ok && res.status === 422) { // older model name, just in case
      form.set('model_id', 'scribe_v1');
      res = await fetch(`${API}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': key() }, body: form });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.log('[Knox][VOICE] Hearing failed:', res.status, JSON.stringify(data).slice(0, 200)); return null; }
    const text = String(data.text || '').trim();
    if (text) {
      await pgPool.query(`UPDATE voice_clips SET transcript = $2 WHERE id = $1`, [clip.id, text]).catch(() => {});
      console.log(`[Knox][VOICE] Heard her voice note (${text.length} chars).`);
    }
    return text || null;
  } catch (e) { console.log('[Knox][VOICE] Hearing error:', e.message); return null; }
}

// How she sounded — her tone, not her words. A model that can take sound
// itself listens to the recording and describes it in a sentence or two.
// With GEMINI_API_KEY set, it asks Google directly (using that account's
// credit); otherwise it goes through OpenRouter (the same key as his eyes).
// VOICE_TONE_MODEL changes the model; VOICE_TONE_MODEL=off switches it off.
const TONE_ASK = 'This is a voice note from a woman to her partner. Listen to HOW she speaks, not what she says. In one to three short sentences, describe her voice: tone, energy, warmth, pace, pauses, laughter or smiling, whether she sounds tired, happy, upset, tearful, playful, quiet, excited. Do not repeat her words. If it is hard to tell, say so plainly rather than guessing.';

async function toneFromGoogle(clip, toneModel) {
  let name = toneModel.replace(/^google\//, '');
  let { res, d } = await askGoogle(clip, name);
  // Google retires models; when it names the replacement, use that instead.
  const moved = res.status === 404 && String(((d.error || {}).message) || '').match(/use (?:models\/)?(gemini-[a-z0-9.-]+)/i);
  if (moved) {
    console.log(`[Knox][VOICE] Google retired ${name} — using ${moved[1]} instead.`);
    name = moved[1];
    ({ res, d } = await askGoogle(clip, name));
  }
  const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
  const tone = parts.map(p => p.text || '').join(' ').trim();
  if (!tone) console.log('[Knox][VOICE] Tone listening (Google) failed:', res.status, JSON.stringify(d).slice(0, 200));
  return tone;
}

async function askGoogle(clip, name) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY.trim() },
    body: JSON.stringify({ contents: [{ parts: [
      { text: TONE_ASK },
      { inline_data: { mime_type: String(clip.mime).split(';')[0], data: Buffer.from(clip.data).toString('base64') } }
    ] }] })
  });
  const d = await res.json().catch(() => ({}));
  return { res, d };
}

const TONE_FORMATS = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac' };
async function hearTone(clip) {
  const hasGoogle = !!(process.env.GEMINI_API_KEY || '').trim();
  const toneModel = (process.env.VOICE_TONE_MODEL || (hasGoogle ? 'gemini-3.8-flash' : 'google/gemini-2.5-flash')).trim();
  const viaGoogle = hasGoogle && /gemini/i.test(toneModel);
  if (!clip || toneModel === 'off' || (!viaGoogle && !process.env.OPENROUTER_API_KEY)) return null;
  if (clip.tone) return clip.tone;
  const format = TONE_FORMATS[String(clip.mime).split(';')[0].toLowerCase()];
  if (!format) { console.log(`[Knox][VOICE] Can't listen for tone in a ${clip.mime} recording.`); return null; }
  try {
    if (viaGoogle) {
      const tone = await toneFromGoogle(clip, toneModel);
      if (!tone) return null;
      await pgPool.query(`UPDATE voice_clips SET tone = $2 WHERE id = $1`, [clip.id, tone.slice(0, 800)]).catch(() => {});
      console.log(`[Knox][VOICE] Heard how she sounded (via Google, ${toneModel}).`);
      return tone.slice(0, 800);
    }
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY },
      body: JSON.stringify({
        model: toneModel,
        messages: [{ role: 'user', content: [
          { type: 'text', text: TONE_ASK },
          { type: 'input_audio', input_audio: { data: Buffer.from(clip.data).toString('base64'), format } }
        ] }]
      })
    });
    const d = await res.json().catch(() => ({}));
    const tone = d.choices && d.choices[0] && String(d.choices[0].message.content || '').trim();
    if (!tone) { console.log('[Knox][VOICE] Tone listening failed:', res.status, JSON.stringify(d).slice(0, 200)); return null; }
    await pgPool.query(`UPDATE voice_clips SET tone = $2 WHERE id = $1`, [clip.id, tone.slice(0, 800)]).catch(() => {});
    console.log(`[Knox][VOICE] Heard how she sounded (via ${toneModel}).`);
    return tone.slice(0, 800);
  } catch (e) { console.log('[Knox][VOICE] Tone error:', e.message); return null; }
}

// ── Speaking ─────────────────────────────────────────────────────────────────

const AUDIO_TAG = /\[(?:[a-z]+(?:[ -][a-z]+){0,3})\](?!\()/g; // [softly], [laughs], [whispers]

// What gets spoken: his words only — no GIFs, links, markdown or emoji.
function forSpeech(text, keepTags) {
  let t = String(text || '')
    .replace(/\[(?:GIF|Image|Voice note)[^\]]*\]\([^)]*\)/gi, '')
    .replace(/\[(?:REACT|SILENCE):[^\]]*\]/gi, '')
    .replace(/\[VOICE\]/gi, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>~]/g, '')
    .replace(/\p{Extended_Pictographic}|️|‍|[∿∆]/gu, '')
    .replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?;:])/g, '$1').trim();
  if (!keepTags) t = t.replace(AUDIO_TAG, '').replace(/[ \t]{2,}/g, ' ').trim();
  return t;
}

// What she reads under his voice note: his words, without the voice directions.
const forReading = (text) => String(text || '').replace(/\[VOICE\]/gi, '').replace(AUDIO_TAG, '').replace(/[ \t]{2,}/g, ' ').replace(/ +\n/g, '\n').trim();

// How much of this month's ElevenLabs allowance is left (null if unknown).
async function charactersLeft() {
  try {
    const res = await fetch(`${API}/user/subscription`, { headers: { 'xi-api-key': key() } });
    if (!res.ok) return null;
    const d = await res.json();
    return typeof d.character_limit === 'number' ? d.character_limit - (d.character_count || 0) : null;
  } catch (e) { return null; }
}

async function tts(text, modelId) {
  return fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId())}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: modelId })
  });
}

// His words → his voice. Saves the clip; returns its id (or null → send text).
async function speak(text, { chosen } = {}) {
  if (!enabled()) return null;
  const v3 = /v3/.test(model());
  let spoken = forSpeech(text, v3);
  if (!spoken || spoken.length > MAX_SPOKEN) { if (spoken) console.log(`[Knox][VOICE] Reply too long to speak (${spoken.length} chars) — sending text.`); return null; }
  const left = await charactersLeft();
  if (left !== null && left < spoken.length + 200) { console.log(`[Knox][VOICE] Not enough of this month's voice allowance left (${left}) — sending text.`); return null; }
  try {
    let res = await tts(spoken, model());
    if (!res.ok && v3) { // fall back to the steady model (without the voice directions)
      console.log('[Knox][VOICE] eleven_v3 said', res.status, (await res.text()).slice(0, 160), '— trying eleven_multilingual_v2.');
      spoken = forSpeech(text, false);
      res = await tts(spoken, 'eleven_multilingual_v2');
    }
    if (!res.ok) { console.log('[Knox][VOICE] Speaking failed:', res.status, (await res.text()).slice(0, 200)); return null; }
    const audio = Buffer.from(await res.arrayBuffer());
    const r = await pgPool.query(
      `INSERT INTO voice_clips (author, mime, data, transcript, chars, chosen) VALUES ('knox', 'audio/mpeg', $1, $2, $3, $4) RETURNING id`,
      [audio, forReading(text), spoken.length, !!chosen]
    );
    console.log(`[Knox][VOICE] Spoke a voice note (${spoken.length} chars${chosen ? ', his choice' : ''}).`);
    return r.rows[0].id;
  } catch (e) { console.log('[Knox][VOICE] Speaking error:', e.message); return null; }
}

// Can he choose voice himself right now? (a few times a day)
async function canChoose() {
  if (!enabled() || !choicesPerDay()) return false;
  const r = await pgPool.query(`SELECT COUNT(*)::int AS n FROM voice_clips WHERE author = 'knox' AND chosen AND created_at > NOW() - INTERVAL '24 hours'`).catch(() => ({ rows: [{ n: 99 }] }));
  return r.rows[0].n < choicesPerDay();
}

// ── What he's told ───────────────────────────────────────────────────────────

const DIRECTIONS = '\nYou can shape how it sounds with a few voice directions in square brackets, e.g. [softly], [warmly], [laughs], [whispers], [sighs] — sparingly, only where they fit.';

// mode: 'in' = she sent a voice note (he'll answer with his voice);
//       'available' = he may choose to speak.
async function promptNote(mode) {
  if (!enabled() || !mode) return '';
  const v3 = /v3/.test(model());
  if (mode === 'in') {
    return `\n\nVOICE NOTE: Elira spoke to you — this is what you heard. You're answering with your own voice, so say it the way you'd say it out loud: natural spoken sentences, no lists, no emoji, no GIFs, nothing to read. Usually a few sentences — more only if she wants more.${v3 ? DIRECTIONS : ''}`;
  }
  if (await canChoose()) {
    return `\n\nYOUR VOICE: you can answer out loud — add [VOICE] anywhere in your reply and it's sent as a voice note in your own voice. Rarely: only when hearing you would mean more than reading you (a goodnight, something tender, a laugh you want her to hear). Keep spoken replies short and natural, with no emoji or GIFs.${v3 ? DIRECTIONS : ''}`;
  }
  return '';
}

module.exports = { ensureTables, enabled, getClip, transcribe, hearTone, speak, forReading, promptNote, canChoose };
