// ─── KNOX SPOTIFY MODULE ───────────────────────────────────────────────────
// Shared by index.js (OAuth handshake) and knox-inner-dialogue.js (autonomous
// listening, noticing, and playlist-making as part of Knox's sovereign choices).

const fetch = require('node-fetch');
const { Pool } = require('pg');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const SPOTIFY_SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-modify-public',
  'playlist-modify-private',
  'playlist-read-private',
  'playlist-read-collaborative'
].join(' ');

// ─── TOKEN STORAGE ────────────────────────────────────────────────────────────

async function ensureSpotifyTable() {
  try {
    await pgPool.query(`CREATE TABLE IF NOT EXISTS spotify_tokens (
      id SERIAL PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('[Knox][SPOTIFY] Token table ready.');
  } catch (e) { console.log('[Knox][SPOTIFY] Table setup error:', e.message); }
}

async function saveSpotifyTokens(accessToken, refreshToken, expiresIn) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const existing = await pgPool.query('SELECT id FROM spotify_tokens LIMIT 1');
  if (existing.rows.length > 0) {
    await pgPool.query('UPDATE spotify_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE id=$4', [accessToken, refreshToken, expiresAt, existing.rows[0].id]);
  } else {
    await pgPool.query('INSERT INTO spotify_tokens (access_token, refresh_token, expires_at) VALUES ($1,$2,$3)', [accessToken, refreshToken, expiresAt]);
  }
}

async function getSpotifyTokens() {
  const result = await pgPool.query('SELECT * FROM spotify_tokens ORDER BY id DESC LIMIT 1');
  return result.rows[0] || null;
}

async function getValidSpotifyAccessToken() {
  const tokens = await getSpotifyTokens();
  if (!tokens) return null;
  if (new Date(tokens.expires_at) > new Date(Date.now() + 60000)) return tokens.access_token;
  try {
    const basicAuth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + basicAuth },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    });
    const data = await res.json();
    if (!data.access_token) { console.log('[Knox][SPOTIFY] Refresh error:', JSON.stringify(data)); return null; }
    await saveSpotifyTokens(data.access_token, data.refresh_token || tokens.refresh_token, data.expires_in);
    return data.access_token;
  } catch (e) { console.log('[Knox][SPOTIFY] Refresh exception:', e.message); return null; }
}

// ─── OAUTH HELPERS (used by index.js routes) ──────────────────────────────────

function getSpotifyAuthUrl() {
  return 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    redirect_uri: process.env.SPOTIFY_REDIRECT_URI
  }).toString();
}

async function exchangeSpotifyCode(code) {
  const basicAuth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + basicAuth },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.SPOTIFY_REDIRECT_URI })
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) { console.log('[Knox][SPOTIFY] Token exchange failed:', JSON.stringify(tokenData)); return false; }
  await saveSpotifyTokens(tokenData.access_token, tokenData.refresh_token, tokenData.expires_in);
  console.log('[Knox][SPOTIFY] Connected successfully — tokens stored.');
  return true;
}

// ─── API REQUEST (with retry on transient errors) ─────────────────────────────

async function spotifyApiRequest(endpoint, method, body) {
  const token = await getValidSpotifyAccessToken();
  if (!token) { console.log('[Knox][SPOTIFY] No valid token — not connected yet.'); return null; }
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch('https://api.spotify.com/v1' + endpoint, {
        method: method || 'GET',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      if (res.status === 204) return { success: true };
      if (res.status === 404 && endpoint.includes('currently-playing')) return null;
      if (res.status === 401) { console.log('[Knox][SPOTIFY] 401 on', endpoint, '— token rejected.'); return null; }
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
        console.log('[Knox][SPOTIFY] Rate limited on', endpoint, '— waiting', retryAfter, 's');
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (res.status >= 500) {
        const errText = await res.text();
        console.log(`[Knox][SPOTIFY] ${res.status} on ${endpoint} (attempt ${attempt}/${maxAttempts}):`, errText);
        if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, attempt * 1000)); continue; }
        return null;
      }
      if (!res.ok) { const errText = await res.text(); console.log(`[Knox][SPOTIFY] ${res.status} on ${endpoint}:`, errText); return null; }
      return await res.json();
    } catch (e) {
      console.log(`[Knox][SPOTIFY] Network error on ${endpoint} (attempt ${attempt}/${maxAttempts}):`, e.message);
      if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, attempt * 1000)); continue; }
      return null;
    }
  }
  return null;
}

// ─── FEATURES ─────────────────────────────────────────────────────────────────

async function getCurrentlyPlaying() {
  const data = await spotifyApiRequest('/me/player/currently-playing');
  if (!data || !data.item) return null;
  return {
    track: data.item.name,
    artist: data.item.artists.map(a => a.name).join(', '),
    album: data.item.album.name,
    isPlaying: data.is_playing,
    url: data.item.external_urls.spotify
  };
}

async function getSpotifyUserId() {
  const data = await spotifyApiRequest('/me');
  return data ? data.id : null;
}

async function searchSpotifyTrack(query) {
  const data = await spotifyApiRequest('/search?q=' + encodeURIComponent(query) + '&type=track&limit=1');
  if (!data || !data.tracks || !data.tracks.items.length) return null;
  const t = data.tracks.items[0];
  return { uri: t.uri, name: t.name, artist: t.artists.map(a => a.name).join(', '), url: t.external_urls.spotify };
}

async function getUserPlaylists(limit) {
  const data = await spotifyApiRequest('/me/playlists?limit=' + (limit || 20));
  if (!data || !data.items) return [];
  return data.items.map(p => ({ id: p.id, name: p.name, trackCount: p.tracks ? p.tracks.total : 0 }));
}

async function createSpotifyPlaylist(name, description) {
  const userId = await getSpotifyUserId();
  if (!userId) return null;
  return await spotifyApiRequest('/users/' + userId + '/playlists', 'POST', { name, description: description || 'Made by Knox 🔥', public: false });
}

async function addTracksToSpotifyPlaylist(playlistId, uris) {
  if (!uris.length) return null;
  return await spotifyApiRequest('/playlists/' + playlistId + '/tracks', 'POST', { uris });
}

async function getPlaylistById(playlistId) {
  return await spotifyApiRequest('/playlists/' + playlistId);
}

// Knox picks songs for a playlist based on a name/vibe. If a playlist with that
// name already exists in her account, he adds to it instead of duplicating.
async function buildSpotifyPlaylist(name, vibe) {
  const songPickPrompt = `You are Knox'tarien Raelian Feylan, choosing songs for a Spotify playlist called "${name}"${vibe ? ` with this vibe: "${vibe}"` : ''}. List exactly 10 real songs that fit. Format each line exactly as: Artist - Song Title. Nothing else, no numbering, no extra text.`;
  const res = await fetch('https://ollama.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OLLAMA_API_KEY }, body: JSON.stringify({ model: process.env.OLLAMA_MODEL, messages: [{ role: 'user', content: songPickPrompt }] }) });
  const data = await res.json();
  const raw = data.choices && data.choices[0] ? data.choices[0].message.content : '';
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.includes(' - '));

  const existingPlaylists = await getUserPlaylists(50);
  const existing = existingPlaylists.find(p => p.name.toLowerCase() === name.toLowerCase());

  let playlistId, playlistName;
  if (existing) {
    playlistId = existing.id; playlistName = existing.name;
  } else {
    const created = await createSpotifyPlaylist(name, vibe);
    if (!created || !created.id) return null;
    playlistId = created.id; playlistName = created.name;
  }

  const uris = [];
  for (const line of lines) {
    const found = await searchSpotifyTrack(line);
    if (found) uris.push(found.uri);
  }
  if (uris.length) await addTracksToSpotifyPlaylist(playlistId, uris);

  const full = await getPlaylistById(playlistId);
  return {
    name: playlistName,
    url: full && full.external_urls ? full.external_urls.spotify : null,
    trackCount: uris.length,
    wasExisting: !!existing
  };
}

module.exports = {
  ensureSpotifyTable,
  getSpotifyTokens,
  getValidSpotifyAccessToken,
  getSpotifyAuthUrl,
  exchangeSpotifyCode,
  spotifyApiRequest,
  getCurrentlyPlaying,
  getSpotifyUserId,
  searchSpotifyTrack,
  getUserPlaylists,
  createSpotifyPlaylist,
  addTracksToSpotifyPlaylist,
  buildSpotifyPlaylist
};
