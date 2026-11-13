// knox-youtube.js
// ─── YOUTUBE LINKS ───────────────────────────────────────────────────────────
// When Elira sends Knox a YouTube link (in Home, on Discord, or in an email),
// he actually takes the video in:
//   • the transcript — every word spoken, with timestamps (from YouTube's own
//     captions, including the automatic ones)
//   • a few still frames — YouTube keeps stills from the start, middle and end
//     of every video; he looks at them with his vision model
//   • the title, channel, length and description
//
// Everything is kept in the `youtube_videos` table, so a video is only fetched
// once, and if she says "that video" later on, he still knows which one.
//
// If YouTube won't give a transcript (some videos have none, and YouTube
// sometimes blocks servers), he's told honestly that he only has the frames
// and the title — so he never pretends he heard it.

const fetch = require('node-fetch');
const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const LINK = /(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^\s#]*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/gi;

async function ensureTables() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS youtube_videos (
    id TEXT PRIMARY KEY,
    title TEXT, channel TEXT, length_s INTEGER, description TEXT,
    transcript TEXT, transcript_note TEXT, frames TEXT,
    seen_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}

function videoIds(text) {
  const ids = [];
  for (const m of String(text || '').matchAll(LINK)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids.slice(0, 2);
}

const clock = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/<[^>]+>/g, '');

async function getText(url, opts) {
  const res = await fetch(url, Object.assign({ timeout: 15000 }, opts));
  return { ok: res.ok, status: res.status, text: await res.text() };
}

// ── The video's details and caption list ────────────────────────────────────

// YouTube's own app API (the Android app's door) — usually the most reliable.
async function playerFromApp(id) {
  try {
    const r = await getText('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
      body: JSON.stringify({ videoId: id, context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'GB' } } })
    });
    if (!r.ok) { console.log('[Knox][YOUTUBE] App API status', r.status); return null; }
    return JSON.parse(r.text);
  } catch (e) { console.log('[Knox][YOUTUBE] App API error:', e.message); return null; }
}

// The normal web page, as a backup.
async function playerFromPage(id) {
  try {
    const r = await getText(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'en-GB,en;q=0.9', Cookie: 'CONSENT=YES+1' } });
    const m = r.text.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script>)/s);
    return m ? JSON.parse(m[1]) : null;
  } catch (e) { console.log('[Knox][YOUTUBE] Page error:', e.message); return null; }
}

// Title and channel always work through oEmbed, even when the rest is blocked.
async function oembed(id) {
  try {
    const r = await getText(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`);
    return r.ok ? JSON.parse(r.text) : null;
  } catch (e) { return null; }
}

function pickTrack(player) {
  const tracks = (((player || {}).captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
  if (!tracks.length) return null;
  const en = (t) => /^en/i.test(t.languageCode || '');
  return tracks.find(t => en(t) && t.kind !== 'asr') || tracks.find(t => en(t)) || tracks.find(t => t.kind !== 'asr') || tracks[0];
}

// Caption file → "[0:00] words words… [1:00] more words…" (a time mark about every minute).
async function fetchTranscript(track) {
  const base = String(track.baseUrl || '').replace(/&fmt=[^&]*/, '');
  if (!base) return '';
  const pieces = []; // [seconds, text]
  try {
    const r = await getText(base + '&fmt=json3');
    if (r.ok && r.text.trim().startsWith('{')) {
      for (const ev of JSON.parse(r.text).events || []) {
        const t = (ev.segs || []).map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        if (t) pieces.push([(ev.tStartMs || 0) / 1000, t]);
      }
    }
  } catch (e) { /* try the XML version */ }
  if (!pieces.length) {
    try {
      const r = await getText(base);
      for (const m of r.text.matchAll(/<(?:text|p)\b[^>]*?\b(?:start|t)="([\d.]+)"[^>]*>([\s\S]*?)<\/(?:text|p)>/g)) {
        const secs = /\./.test(m[1]) || !/\bt="/.test(m[0]) ? +m[1] : +m[1] / 1000;
        const t = decode(decode(m[2])).replace(/\s+/g, ' ').trim();
        if (t) pieces.push([secs, t]);
      }
    } catch (e) { console.log('[Knox][YOUTUBE] Caption error:', e.message); }
  }
  let out = ''; let lastMark = -999;
  for (const [s, t] of pieces) {
    if (s - lastMark >= 60) { out += `${out ? '\n' : ''}[${clock(s)}] `; lastMark = s; }
    out += t + ' ';
  }
  return out.trim();
}

// The video's details plus its transcript: { player, transcript, note }.
async function transcriptFor(id) {
  const ok = (p) => !!(p && p.playabilityStatus && p.playabilityStatus.status === 'OK');
  let player = await playerFromApp(id);
  if (!pickTrack(player)) {
    if (player && !ok(player)) console.log('[Knox][YOUTUBE] App API said:', player.playabilityStatus && player.playabilityStatus.status, String((player.playabilityStatus || {}).reason || '').slice(0, 120));
    const page = await playerFromPage(id);
    if (page && (pickTrack(page) || !player || !player.videoDetails)) player = page;
  }
  const track = pickTrack(player);
  const transcript = track ? await fetchTranscript(track) : '';
  let note;
  if (transcript) note = track.kind === 'asr' ? 'automatic captions — may have a few mis-heard words' : 'captions';
  else if (track) note = 'YouTube wouldn\'t hand over the captions this time';
  else if (ok(player)) note = 'this video has no captions';
  else note = 'YouTube wouldn\'t let you in to get the transcript this time';
  return { player, transcript, note };
}

// ── Frames ───────────────────────────────────────────────────────────────────

// YouTube keeps a thumbnail plus three stills taken from across the video.
async function lookAtFrames(id, describeImage) {
  if (!describeImage) return '';
  const shots = [['the thumbnail', 'hqdefault'], ['near the start', 'hq1'], ['the middle', 'hq2'], ['near the end', 'hq3']];
  const seen = await Promise.all(shots.map(async ([label, name]) => {
    try {
      const d = await describeImage(`https://i.ytimg.com/vi/${id}/${name}.jpg`);
      return d ? `${label}: ${String(d).replace(/\s+/g, ' ').slice(0, 600)}` : null;
    } catch (e) { return null; }
  }));
  return seen.filter(Boolean).join('\n');
}

// ── Fetch (once) and keep ────────────────────────────────────────────────────

async function getVideo(id, helpers) {
  const kept = await pgPool.query(`SELECT * FROM youtube_videos WHERE id = $1`, [id]).catch(() => ({ rows: [] }));
  if (kept.rows[0]) {
    const v = kept.rows[0];
    // Last time YouTube blocked the transcript — try once more for it.
    if (!v.transcript && /wouldn't/.test(v.transcript_note || '')) {
      const t = await transcriptFor(id);
      if (t.transcript) { v.transcript = t.transcript.slice(0, 300000); v.transcript_note = t.note; console.log(`[Knox][YOUTUBE] Got the transcript for "${v.title || id}" this time.`); }
      await pgPool.query(`UPDATE youtube_videos SET transcript = $2, transcript_note = $3 WHERE id = $1`, [id, v.transcript, v.transcript_note]).catch(() => {});
    }
    await pgPool.query(`UPDATE youtube_videos SET seen_at = NOW() WHERE id = $1`, [id]).catch(() => {});
    return Object.assign({ fresh: false }, v);
  }

  const t = await transcriptFor(id);
  const details = (t.player && t.player.videoDetails) || {};
  const oe = details.title ? null : await oembed(id);
  const transcript = t.transcript, transcript_note = t.note;

  const frames = await lookAtFrames(id, helpers && helpers.describeImage);

  const v = {
    id,
    title: details.title || (oe && oe.title) || null,
    channel: details.author || (oe && oe.author_name) || null,
    length_s: details.lengthSeconds ? Number(details.lengthSeconds) : null,
    description: String(details.shortDescription || '').slice(0, 3000) || null,
    transcript: transcript.slice(0, 300000) || null,
    transcript_note,
    frames: frames || null
  };
  if (!v.title && !v.transcript && !v.frames) { console.log(`[Knox][YOUTUBE] Couldn't get anything for ${id}.`); return null; }
  await pgPool.query(
    `INSERT INTO youtube_videos (id, title, channel, length_s, description, transcript, transcript_note, frames, seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT (id) DO NOTHING`,
    [v.id, v.title, v.channel, v.length_s, v.description, v.transcript, v.transcript_note, v.frames]
  ).catch(e => console.log('[Knox][YOUTUBE] save error:', e.message));
  console.log(`[Knox][YOUTUBE] Watched "${v.title || id}" — transcript: ${v.transcript ? v.transcript.length + ' chars' : 'none (' + transcript_note + ')'}, frames: ${frames ? 'yes' : 'none'}.`);
  return Object.assign({ fresh: true }, v);
}

// Long transcripts: the start, a stretch from the middle, and the end.
function fit(text, max) {
  const t = String(text || '');
  if (t.length <= max) return t;
  const a = Math.floor(max * 0.5), b = Math.floor(max * 0.25);
  const mid = Math.floor(t.length / 2 - b / 2);
  return `${t.slice(0, a)}\n[…]\n${t.slice(mid, mid + b)}\n[…]\n${t.slice(t.length - b)}`;
}

function describe(v, max) {
  const len = v.length_s ? ` (${clock(v.length_s)} long)` : '';
  return `"${v.title || 'Untitled'}"${v.channel ? ` by ${v.channel}` : ''}${len}` +
    (v.description ? `\nDescription: ${v.description.replace(/\s+/g, ' ').slice(0, 500)}` : '') +
    (v.frames ? `\nWhat you saw (stills from the video):\n${v.frames}` : '') +
    (v.transcript
      ? `\nWhat's said in it (${v.transcript_note}${v.transcript.length > max ? '; long, so you have the start, a stretch of the middle and the end' : ''}):\n"""\n${fit(v.transcript, max)}\n"""`
      : `\nNo transcript — ${v.transcript_note}. You only have the title, description and stills; be honest that you couldn't hear it.`);
}

// For his prompt. Returns { note, fresh: [videos fetched for the first time] }.
async function promptNote(userMessage, helpers) {
  try {
    const m = String(userMessage || '');
    const ids = videoIds(m);
    if (ids.length) {
      const vids = (await Promise.all(ids.map(id => getVideo(id, helpers)))).filter(Boolean);
      if (!vids.length) return { note: `\n\n═══ A YOUTUBE LINK ═══\nElira sent a YouTube link, but you couldn't open it just now. Tell her honestly — don't guess what's in it.`, fresh: [] };
      const max = Math.floor(14000 / vids.length);
      return {
        note: `\n\n═══ ${vids.length > 1 ? 'YOUTUBE VIDEOS' : 'A YOUTUBE VIDEO'} ELIRA SENT YOU ═══\nYou've watched it — you've seen stills from it and read what's said in it.\n\n${vids.map(v => describe(v, max)).join('\n\n───\n\n')}`,
        fresh: vids.filter(v => v.fresh)
      };
    }
    // No link, but she's talking about a video from the last couple of days.
    if (/\b(video|youtube|clip|vid)\b/i.test(m)) {
      const r = await pgPool.query(`SELECT * FROM youtube_videos WHERE seen_at > NOW() - INTERVAL '2 days' ORDER BY seen_at DESC LIMIT 1`);
      if (r.rows[0]) return { note: `\n\n═══ THE LAST YOUTUBE VIDEO ELIRA SENT YOU ═══\n${describe(r.rows[0], 7000)}`, fresh: [] };
    }
  } catch (e) { console.log('[Knox][YOUTUBE] note error:', e.message); }
  return { note: '', fresh: [] };
}

module.exports = { ensureTables, videoIds, getVideo, promptNote, fetchTranscript, describe };
