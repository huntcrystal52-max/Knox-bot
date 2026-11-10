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

// ─── GIFS SHE SENDS HIM ──────────────────────────────────────────────────────

// Search results for her GIF picker in the app.
async function searchMany(query, limit) {
  if (!enabled() || !String(query || '').trim()) return [];
  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(process.env.GIPHY_API_KEY)}&q=${encodeURIComponent(String(query).slice(0, 80))}&limit=${Math.min(24, limit || 18)}&rating=pg-13&lang=en`;
    const data = await (await fetch(url)).json();
    return ((data && data.data) || []).map(g => {
      const i = g.images || {};
      const full = (i.downsized_medium || i.fixed_height || i.original || {}).url;
      const preview = (i.fixed_width_small || i.fixed_width || i.fixed_height_small || {}).url;
      return full ? { url: full.split('?')[0], preview: (preview || full).split('?')[0], title: String(g.title || '').replace(/\s+GIF\b.*$/i, '').trim() || 'GIF' } : null;
    }).filter(Boolean);
  } catch (e) { console.log('[Knox][GIF] picker search error:', e.message); return []; }
}

// A still frame he can look at (GIPHY offers one next to every GIF).
function stillOf(url) {
  const u = String(url || '');
  return /media\d*\.giphy\.com\/media\/[^/]+\/[^/]+\.gif$/i.test(u) ? u.replace(/\/([^/]+)\.gif$/i, '/giphy_s.gif') : u;
}

// Words from a GIF link itself, e.g. tenor.com/view/happy-dance-gif-123 → "happy dance".
function wordsFromLink(url) {
  const m = String(url || '').match(/(?:tenor\.com\/(?:[a-z-]+\/)?view|giphy\.com\/gifs)\/([^/?#]+)/i);
  if (!m) return '';
  return decodeURIComponent(m[1]).replace(/-?gif-?\d*$/i, '').replace(/-[A-Za-z0-9]{8,}$/, '').replace(/-\d+$/, '').replace(/-/g, ' ').trim();
}

// Her message, if it's (mostly) a GIF: { words, imageUrl, rest } or null.
// Covers the app's [GIF: words](url) and Discord's Tenor/GIPHY links.
function fromHer(text) {
  const t = String(text || '');
  const app = t.match(/\[GIF:\s*([^\]]{1,80})\]\((https:\/\/[^)\s]+)\)/i);
  if (app) return { words: app[1].trim(), imageUrl: stillOf(app[2]), rest: t.replace(app[0], '').trim() };
  const link = t.match(/https?:\/\/(?:www\.)?(?:tenor\.com|giphy\.com|media\d*\.giphy\.com)\/\S+/i);
  if (link) return { words: wordsFromLink(link[0]), imageUrl: /\.gif$/i.test(link[0]) ? stillOf(link[0]) : null, rest: t.replace(link[0], '').trim() };
  return null;
}

module.exports = { attachGif, splitForDiscord, promptNote, enabled, searchMany, fromHer, stillOf };
