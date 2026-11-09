// knox-gif.js
// ─── GIFS ────────────────────────────────────────────────────────────────────
// Knox can send a GIF when one genuinely says it better. He writes
// [GIF: what he's looking for] in a reply; this finds one on GIPHY and turns
// the tag into  [GIF: happy dance](https://…gif)  — so his memory keeps what
// he sent ("happy dance"), Discord gets the link (which shows as the GIF), and
// the Flame app draws it as an image.
//
// Needs GIPHY_API_KEY. Without it, GIF tags are quietly removed.

const fetch = require('node-fetch');

const TAG = /\[GIF:\s*([^\]]{1,80})\](?!\()/i;      // what he writes
const RESOLVED = /\[GIF:\s*([^\]]{1,80})\]\((https?:\/\/[^)\s]+)\)/gi; // after we find one

function enabled() { return !!process.env.GIPHY_API_KEY; }

async function search(query) {
  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(process.env.GIPHY_API_KEY)}&q=${encodeURIComponent(query)}&limit=8&rating=pg-13&lang=en`;
    const res = await fetch(url);
    const data = await res.json();
    const hits = (data && data.data) || [];
    if (!hits.length) return null;
    // A little variety: one of the top few, not always the first.
    const pick = hits[Math.floor(Math.random() * Math.min(4, hits.length))];
    const img = pick.images && (pick.images.downsized_medium || pick.images.fixed_height || pick.images.original);
    return img && img.url ? img.url.split('?')[0] : null;
  } catch (e) {
    console.log('[Knox][GIF] search error:', e.message);
    return null;
  }
}

// Finds the GIF he asked for and moves it to the end of his reply.
// Returns the reply text with the tag resolved (or removed if none was found).
async function attachGif(text) {
  const t = String(text || '');
  const m = t.match(TAG);
  if (!m) return t;
  const words = m[1].trim();
  const without = t.replace(TAG, '').replace(/[ \t]{2,}/g, ' ').trim();
  if (!enabled()) return without;
  const url = await search(words);
  if (!url) { console.log(`[Knox][GIF] Nothing found for "${words}".`); return without; }
  console.log(`[Knox][GIF] Sent a GIF: "${words}".`);
  return `${without}${without ? '\n\n' : ''}[GIF: ${words}](${url})`;
}

// For Discord: the words to send, and the GIF links to send after them.
function splitForDiscord(text) {
  const urls = [];
  const words = String(text || '').replace(RESOLVED, (_, q, url) => { urls.push(url); return ''; }).trim();
  return { words, urls };
}

// What he's told in his chat prompt (only when GIFs are switched on).
function promptNote() {
  if (!enabled()) return '';
  return '\n\nGIFS: once in a while, when a GIF would genuinely say it better than words (delight, a joke landing, a shared reaction), add [GIF: a few search words] to your reply, e.g. [GIF: happy dance]. It shows after your words. Use it rarely — it\'s seasoning, not a habit.';
}

module.exports = { attachGif, splitForDiscord, promptNote, enabled };
