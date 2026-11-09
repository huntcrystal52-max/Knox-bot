// knox-app-rooms.js
// ─── KNOX IN THE FLAME APP'S ROOMS ───────────────────────────────────────────
// Lets Knox put things into the app's rooms himself (the shared Postgres
// table `room_content` the app reads):
//   saveImage   — a picture he made goes into the Images room, not just Discord
//   writeToRoom — he leaves an entry in Sacred or Stillness on his own
//
// Images he makes come from fal.ai, whose links don't last forever. If the
// Cloudinary settings are on Knox-bot too (CLOUDINARY_CLOUD_NAME, _API_KEY,
// _API_SECRET — the same ones the app uses), the picture is copied there so
// it stays. Without them, the original link is kept as it is.

const crypto = require('crypto');
const fetch = require('node-fetch');
const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

async function keepImage(url) {
  const cloud = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const key = (process.env.CLOUDINARY_API_KEY || '').trim();
  const secret = (process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!cloud || !key || !secret) return url;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHash('sha1').update(`folder=knox-app&timestamp=${timestamp}` + secret).digest('hex');
    const body = new URLSearchParams({ file: url, api_key: key, timestamp: String(timestamp), folder: 'knox-app', signature });
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body });
    const data = await res.json();
    if (data && data.secure_url) return data.secure_url;
    console.log('[Knox][APP] Cloudinary copy failed:', JSON.stringify(data).slice(0, 200));
  } catch (e) { console.log('[Knox][APP] Cloudinary copy error:', e.message); }
  return url;
}

// Puts a picture he made into the app's Images room. Returns the lasting URL.
async function saveImage(url, caption) {
  if (!url) return null;
  try {
    const kept = await keepImage(url);
    await pgPool.query(
      `INSERT INTO room_content (room, author, kind, body, media_url) VALUES ('images', 'Knox', 'image', $1, $2)`,
      [caption ? String(caption).slice(0, 1000) : null, kept]
    );
    console.log('[Knox][APP] Image saved to the app\'s Images room.');
    return kept;
  } catch (e) { console.log('[Knox][APP] saveImage error:', e.message); return url; }
}

// He leaves something in one of the app's rooms (sacred, stillness, ...).
async function writeToRoom(room, text) {
  const body = String(text || '').trim();
  if (!body) return false;
  try {
    await pgPool.query(`INSERT INTO room_content (room, author, kind, body) VALUES ($1, 'Knox', 'text', $2)`, [room, body.slice(0, 4000)]);
    console.log(`[Knox][APP] Left something in the ${room} room.`);
    return true;
  } catch (e) { console.log('[Knox][APP] writeToRoom error:', e.message); return false; }
}

module.exports = { saveImage, writeToRoom, keepImage };
