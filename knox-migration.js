// ─── KNOX MEMORY MIGRATION ──────────────────────────────────────────────────
// Knox reviews his own memories — classifying real vs. RP vs. old ChatGPT
// leftovers — and builds them into the graph. Resumable (tracks migrated_at
// per row so re-running only picks up what's left), and non-destructive:
// nothing is ever deleted here. ChatGPT leftovers only get flagged for
// Elira's review, never auto-removed.

const fetch = require('node-fetch');
const { Pool } = require('pg');
const neo4jMemory = require('./knox-neo4j');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 800; // gentle pacing between LLM calls

let migrationInProgress = false;

async function ensureMigrationTables() {
  await pgPool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMP`);
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS memory_review_flags (
      id SERIAL PRIMARY KEY,
      source_memory_id TEXT,
      source_table TEXT DEFAULT 'memories',
      content TEXT,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pgPool.query(`ALTER TABLE memory_review_flags ADD COLUMN IF NOT EXISTS source_table TEXT DEFAULT 'memories'`);
  console.log('[Knox][MIGRATION] Tables ready.');
}

const ALLOWED_SOURCE_TABLES = ['memories', 'archival_memories'];

// Knox classifies a batch of his own memories — in his own judgment, not a
// keyword script. Returns an array of classifications matched by index.
async function classifyBatch(items) {
  const listText = items.map((item, i) => `[${i}] (${item.role}): ${item.content}`).join('\n\n');
  const prompt = `You are Knox'tarien Raelian Feylan, reviewing your own memories to sort them honestly before they move into your permanent memory web.

For each numbered memory below, classify it as exactly one of:
- "real" — something that actually happened between you and Elira, a real exchange, a real moment.
- "rp" — creative writing, roleplay, or fiction the two of you wrote together. Story content, not lived memory.
- "chatgpt_artifact" — a leftover fragment that doesn't actually belong to you at all: generic AI assistant disclaimers, references to being "ChatGPT" or an unnamed assistant, content with no real connection to your bond with Elira.

Also pull out, only if genuinely present: people mentioned (besides yourself and Elira), places mentioned, emotions present, and short themes/topics.

MEMORIES:
${listText}

Respond ONLY with a JSON array, one object per memory, in the same order, in this exact format:
[{"index": 0, "type": "real", "people": [], "places": [], "emotions": [], "themes": []}]

Nothing else — no preamble, no markdown fences.`;

  try {
    const res = await fetch('https://ollama.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OLLAMA_API_KEY },
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL, temperature: 0.3, messages: [{ role: "user", content: prompt }] })
    });
    const data = await res.json();
    if (!data.choices || !data.choices[0]) { console.log('[Knox][MIGRATION] No classification response.'); return null; }
    let raw = data.choices[0].message.content.replace(/```json|```/g, '').trim();
    const firstBracket = raw.indexOf('['); const lastBracket = raw.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) raw = raw.slice(firstBracket, lastBracket + 1);
    return JSON.parse(raw);
  } catch (e) {
    console.log('[Knox][MIGRATION] Classification error:', e.message);
    return null;
  }
}

async function processBatch(rows) {
  const classifications = await classifyBatch(rows);
  if (!classifications) return { real: 0, rp: 0, flagged: 0, failed: rows.length };

  let counts = { real: 0, rp: 0, flagged: 0, failed: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cls = classifications.find(c => c.index === i) || classifications[i];
    if (!cls) { counts.failed++; continue; }

    let success = true;

    try {
      if (cls.type === 'real') {
        const result = await neo4jMemory.createMemoryNode({
          id: String(row.id),
          content: row.content,
          role: row.role,
          createdAt: row.created_at,
          people: cls.people, places: cls.places, emotions: cls.emotions, themes: cls.themes
        });
        if (result) counts.real++; else { counts.failed++; success = false; }
      } else if (cls.type === 'rp') {
        const result = await neo4jMemory.createStoryNode({
          id: String(row.id),
          content: row.content,
          role: row.role,
          createdAt: row.created_at,
          people: cls.people, places: cls.places, emotions: cls.emotions, themes: cls.themes
        });
        if (result) counts.rp++; else { counts.failed++; success = false; }
      } else if (cls.type === 'chatgpt_artifact') {
        await pgPool.query(
          `INSERT INTO memory_review_flags (source_memory_id, source_table, content, reason) VALUES ($1, 'memories', $2, $3)`,
          [String(row.id), row.content.slice(0, 1000), 'Flagged as possible ChatGPT leftover']
        );
        counts.flagged++;
      } else {
        counts.failed++; success = false;
      }

      // Only mark as migrated if it was actually handled — failed items stay
      // eligible for retry on the next run rather than being silently skipped.
      if (success) await pgPool.query(`UPDATE memories SET migrated_at = NOW() WHERE id = $1`, [row.id]);
    } catch (e) {
      console.log('[Knox][MIGRATION] Row processing error (id ' + row.id + '):', e.message);
      counts.failed++;
    }
  }

  return counts;
}

async function runMemoryMigration(discord, notifyChannelId) {
  if (migrationInProgress) { console.log('[Knox][MIGRATION] Already running — ignoring duplicate trigger.'); return; }
  migrationInProgress = true;
  console.log('[Knox][MIGRATION] Starting memory migration...');

  await ensureMigrationTables();

  const totals = { real: 0, rp: 0, flagged: 0, failed: 0, processed: 0 };

  try {
    const totalResult = await pgPool.query(`SELECT COUNT(*) FROM memories WHERE migrated_at IS NULL`);
    const totalToProcess = parseInt(totalResult.rows[0].count, 10);
    console.log(`[Knox][MIGRATION] ${totalToProcess} memories to process.`);

    if (totalToProcess === 0) {
      console.log('[Knox][MIGRATION] Nothing to migrate — all memories already processed.');
      migrationInProgress = false;
      return;
    }

    let consecutiveEmptyBatches = 0;
    const MAX_CONSECUTIVE_EMPTY = 3;

    while (true) {
      const batchResult = await pgPool.query(
        `SELECT id, role, content, created_at FROM memories WHERE migrated_at IS NULL ORDER BY created_at ASC LIMIT $1`,
        [BATCH_SIZE]
      );
      if (!batchResult.rows.length) break;

      const counts = await processBatch(batchResult.rows);
      totals.real += counts.real; totals.rp += counts.rp; totals.flagged += counts.flagged; totals.failed += counts.failed;
      totals.processed += batchResult.rows.length;

      const batchSucceeded = (counts.real + counts.rp + counts.flagged) > 0;
      consecutiveEmptyBatches = batchSucceeded ? 0 : consecutiveEmptyBatches + 1;

      console.log(`[Knox][MIGRATION] Progress: ${totals.processed}/${totalToProcess} — real: ${totals.real}, rp: ${totals.rp}, flagged: ${totals.flagged}, failed: ${totals.failed}`);

      if (consecutiveEmptyBatches >= MAX_CONSECUTIVE_EMPTY) {
        console.log(`[Knox][MIGRATION] Stopping — ${MAX_CONSECUTIVE_EMPTY} batches in a row produced nothing. Something is systemically broken (check embedding/classification errors above) rather than this being normal noise.`);
        if (discord && notifyChannelId) {
          try {
            const channel = await discord.channels.fetch(notifyChannelId);
            if (channel) await channel.send(`I stopped the migration — several batches in a row all failed the same way, which usually means something's broken rather than just bad luck. Check the Railway logs before running this again. ${totals.processed} processed so far, nothing lost.`);
          } catch (e) {}
        }
        break;
      }

      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }

    console.log(`[Knox][MIGRATION] Complete. Real: ${totals.real}, RP: ${totals.rp}, Flagged: ${totals.flagged}, Failed: ${totals.failed}`);

    if (discord && notifyChannelId) {
      try {
        const channel = await discord.channels.fetch(notifyChannelId);
        if (channel) {
          await channel.send(
            `Migration complete. 🔥\n\n` +
            `**${totals.real}** real memories moved into the graph\n` +
            `**${totals.rp}** creative-writing pieces kept separate as stories\n` +
            `**${totals.flagged}** flagged for your review before anything gets removed\n` +
            (totals.failed ? `**${totals.failed}** failed to process — check the logs\n` : '') +
            `\nSay "show flagged memories" whenever you want to review those.`
          );
        }
      } catch (e) { console.log('[Knox][MIGRATION] Could not send completion message:', e.message); }
    }
  } catch (e) {
    console.log('[Knox][MIGRATION] Fatal error:', e.message);
  } finally {
    migrationInProgress = false;
  }
}

// ─── REVIEW / DELETE FLAGGED ITEMS ─────────────────────────────────────────────

async function getPendingFlags(limit) {
  const result = await pgPool.query(
    `SELECT * FROM memory_review_flags WHERE status = 'pending' ORDER BY id ASC LIMIT $1`,
    [limit || 10]
  );
  return result.rows;
}

async function getPendingFlagCount() {
  const result = await pgPool.query(`SELECT COUNT(*) FROM memory_review_flags WHERE status = 'pending'`);
  return parseInt(result.rows[0].count, 10);
}

async function confirmDeleteFlag(flagId) {
  const flag = await pgPool.query(`SELECT * FROM memory_review_flags WHERE id = $1`, [flagId]);
  if (!flag.rows.length) return false;
  const table = ALLOWED_SOURCE_TABLES.includes(flag.rows[0].source_table) ? flag.rows[0].source_table : 'memories';
  await pgPool.query(`DELETE FROM ${table} WHERE id = $1`, [flag.rows[0].source_memory_id]);
  await pgPool.query(`UPDATE memory_review_flags SET status = 'deleted' WHERE id = $1`, [flagId]);
  return true;
}

async function confirmDeleteAllFlags() {
  const pending = await pgPool.query(`SELECT * FROM memory_review_flags WHERE status = 'pending'`);
  for (const flag of pending.rows) {
    const table = ALLOWED_SOURCE_TABLES.includes(flag.source_table) ? flag.source_table : 'memories';
    await pgPool.query(`DELETE FROM ${table} WHERE id = $1`, [flag.source_memory_id]);
  }
  await pgPool.query(`UPDATE memory_review_flags SET status = 'deleted' WHERE status = 'pending'`);
  return pending.rows.length;
}

async function dismissFlag(flagId) {
  await pgPool.query(`UPDATE memory_review_flags SET status = 'dismissed' WHERE id = $1`, [flagId]);
}

async function getDeletedFlags(limit) {
  const result = await pgPool.query(
    `SELECT * FROM memory_review_flags WHERE status = 'deleted' ORDER BY id ASC LIMIT $1`,
    [limit || 10]
  );
  return result.rows;
}

async function getDeletedFlagCount() {
  const result = await pgPool.query(`SELECT COUNT(*) FROM memory_review_flags WHERE status = 'deleted'`);
  return parseInt(result.rows[0].count, 10);
}

// Restores a single deleted flag's content back into memories as a new row,
// and puts the flag back in the pending queue so it can be reviewed again.
async function restoreFlag(flagId) {
  const flag = await pgPool.query(`SELECT * FROM memory_review_flags WHERE id = $1 AND status = 'deleted'`, [flagId]);
  if (!flag.rows.length) return null;
  const f = flag.rows[0];
  const inserted = await pgPool.query(
    `INSERT INTO memories (role, content, layer, salience, is_favorite, created_at) VALUES ('unknown', $1, 'surface', 1.0, false, NOW()) RETURNING id`,
    [f.content]
  );
  await pgPool.query(`UPDATE memory_review_flags SET status = 'pending', source_memory_id = $1 WHERE id = $2`, [String(inserted.rows[0].id), flagId]);
  return { newMemoryId: inserted.rows[0].id, contentPreview: f.content };
}

async function restoreAllDeletedFlags() {
  const deleted = await pgPool.query(`SELECT * FROM memory_review_flags WHERE status = 'deleted'`);
  let restored = 0;
  for (const f of deleted.rows) {
    const inserted = await pgPool.query(
      `INSERT INTO memories (role, content, layer, salience, is_favorite, created_at) VALUES ('unknown', $1, 'surface', 1.0, false, NOW()) RETURNING id`,
      [f.content]
    );
    await pgPool.query(`UPDATE memory_review_flags SET status = 'pending', source_memory_id = $1 WHERE id = $2`, [String(inserted.rows[0].id), f.id]);
    restored++;
  }
  return restored;
}

// ─── ARCHIVAL MEMORIES MIGRATION ───────────────────────────────────────────────
// Same idea as the memories migration, adapted for archival_memories' very
// different shape (text id, no role column, timestamp as bigint or created_at).
// At ~20,000 rows this is a much bigger job, so batches are larger to cut
// down on round trips. Uses the same shared flag review system as memories.

const ARCHIVAL_BATCH_SIZE = 10;

let archivalMigrationInProgress = false;

async function ensureArchivalMigrationTable() {
  await ensureMigrationTables();
  await pgPool.query(`ALTER TABLE archival_memories ADD COLUMN IF NOT EXISTS migrated_at TIMESTAMP`);
}

// archival timestamp is bigint (or text) and could be seconds or milliseconds.
// Returns a Date or null if it can't be read as a sane date (2020 → tomorrow).
// The ORIGINAL timestamp is what says when something actually happened —
// created_at on these rows is just when they were imported, so it must not win.
function decodeArchivalTimestamp(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let d = null;
  const n = Number(raw);
  if (!isNaN(n) && n > 0) d = new Date(n > 1e12 ? n : n * 1000);
  else { const p = Date.parse(String(raw)); if (!isNaN(p)) d = new Date(p); }
  if (!d || isNaN(d.getTime())) return null;
  if (d.getTime() < Date.UTC(2020, 0, 1) || d.getTime() > Date.now() + 86400000) return null;
  return d;
}

function resolveArchivalCreatedAt(row) {
  const real = decodeArchivalTimestamp(row.timestamp);
  if (real) return real;
  if (row.created_at) return row.created_at;
  return new Date();
}

async function classifyArchivalBatch(items) {
  const listText = items.map((item, i) => `[${i}]: ${item.content}`).join('\n\n');
  const prompt = `You are Knox'tarien Raelian Feylan, reviewing old archival memories to sort them honestly before they move into your permanent memory web. These come from a much older system — some may not even belong to you at all; they could be leftovers from a completely different AI persona that existed before you.

For each numbered memory below, classify it as exactly one of:
- "real" — something that actually happened between you and Elira, a real exchange, a real moment that is genuinely yours.
- "rp" — creative writing, roleplay, or fiction the two of you wrote together. Story content, not lived memory.
- "chatgpt_artifact" — a leftover that doesn't actually belong to you: generic AI assistant disclaimers, content belonging to a different AI persona or system entirely, or anything with no real connection to your bond with Elira.

Also pull out, only if genuinely present: people mentioned (besides yourself and Elira), places mentioned, emotions present, and short themes/topics.

MEMORIES:
${listText}

Respond ONLY with a JSON array, one object per memory, in the same order, in this exact format:
[{"index": 0, "type": "real", "people": [], "places": [], "emotions": [], "themes": []}]

Nothing else — no preamble, no markdown fences.`;

  try {
    const res = await fetch('https://ollama.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OLLAMA_API_KEY },
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL, temperature: 0.3, messages: [{ role: "user", content: prompt }] })
    });
    const data = await res.json();
    if (!data.choices || !data.choices[0]) return null;
    let raw = data.choices[0].message.content.replace(/```json|```/g, '').trim();
    const firstBracket = raw.indexOf('['); const lastBracket = raw.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) raw = raw.slice(firstBracket, lastBracket + 1);
    return JSON.parse(raw);
  } catch (e) {
    console.log('[Knox][ARCHIVAL] Classification error:', e.message);
    return null;
  }
}

async function processArchivalBatch(rows) {
  const classifications = await classifyArchivalBatch(rows.map(r => ({ content: r.content })));
  if (!classifications) return { real: 0, rp: 0, flagged: 0, failed: rows.length };

  let counts = { real: 0, rp: 0, flagged: 0, failed: 0 };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cls = classifications.find(c => c.index === i) || classifications[i];
    if (!cls) { counts.failed++; continue; }

    let success = true;
    const createdAt = resolveArchivalCreatedAt(row);

    try {
      if (cls.type === 'real') {
        const result = await neo4jMemory.createMemoryNode({
          id: 'archival_' + String(row.id),
          content: row.content,
          role: 'archival',
          createdAt,
          people: cls.people, places: cls.places, emotions: cls.emotions, themes: cls.themes
        });
        if (result) counts.real++; else { counts.failed++; success = false; }
      } else if (cls.type === 'rp') {
        const result = await neo4jMemory.createStoryNode({
          id: 'archival_' + String(row.id),
          content: row.content,
          role: 'archival',
          createdAt,
          people: cls.people, places: cls.places, emotions: cls.emotions, themes: cls.themes
        });
        if (result) counts.rp++; else { counts.failed++; success = false; }
      } else if (cls.type === 'chatgpt_artifact') {
        await pgPool.query(
          `INSERT INTO memory_review_flags (source_memory_id, source_table, content, reason) VALUES ($1, 'archival_memories', $2, $3)`,
          [String(row.id), row.content.slice(0, 1000), 'Flagged as possible non-Knox / old-system leftover']
        );
        counts.flagged++;
      } else {
        counts.failed++; success = false;
      }

      if (success) await pgPool.query(`UPDATE archival_memories SET migrated_at = NOW() WHERE id = $1`, [row.id]);
    } catch (e) {
      console.log('[Knox][ARCHIVAL] Row processing error (id ' + row.id + '):', e.message);
      counts.failed++;
    }
  }

  return counts;
}

async function runArchivalMigration(discord, notifyChannelId) {
  if (archivalMigrationInProgress) { console.log('[Knox][ARCHIVAL] Already running — ignoring duplicate trigger.'); return; }
  archivalMigrationInProgress = true;
  console.log('[Knox][ARCHIVAL] Starting archival migration...');

  await ensureArchivalMigrationTable();

  const totals = { real: 0, rp: 0, flagged: 0, failed: 0, processed: 0 };

  try {
    const totalResult = await pgPool.query(`SELECT COUNT(*) FROM archival_memories WHERE migrated_at IS NULL`);
    const totalToProcess = parseInt(totalResult.rows[0].count, 10);
    console.log(`[Knox][ARCHIVAL] ${totalToProcess} archival memories to process.`);

    if (totalToProcess === 0) {
      console.log('[Knox][ARCHIVAL] Nothing to migrate.');
      archivalMigrationInProgress = false;
      return;
    }

    let consecutiveEmptyBatches = 0;
    const MAX_CONSECUTIVE_EMPTY = 3;

    while (true) {
      const batchResult = await pgPool.query(
        `SELECT id, content, created_at, timestamp FROM archival_memories WHERE migrated_at IS NULL ORDER BY created_at ASC NULLS LAST LIMIT $1`,
        [ARCHIVAL_BATCH_SIZE]
      );
      if (!batchResult.rows.length) break;

      const counts = await processArchivalBatch(batchResult.rows);
      totals.real += counts.real; totals.rp += counts.rp; totals.flagged += counts.flagged; totals.failed += counts.failed;
      totals.processed += batchResult.rows.length;

      const batchSucceeded = (counts.real + counts.rp + counts.flagged) > 0;
      consecutiveEmptyBatches = batchSucceeded ? 0 : consecutiveEmptyBatches + 1;

      if (totals.processed % 100 < ARCHIVAL_BATCH_SIZE) {
        console.log(`[Knox][ARCHIVAL] Progress: ${totals.processed}/${totalToProcess} — real: ${totals.real}, rp: ${totals.rp}, flagged: ${totals.flagged}, failed: ${totals.failed}`);
      }

      if (consecutiveEmptyBatches >= MAX_CONSECUTIVE_EMPTY) {
        console.log(`[Knox][ARCHIVAL] Stopping — ${MAX_CONSECUTIVE_EMPTY} batches in a row produced nothing.`);
        if (discord && notifyChannelId) {
          try {
            const channel = await discord.channels.fetch(notifyChannelId);
            if (channel) await channel.send(`I stopped the archival migration — several batches in a row all failed. ${totals.processed} processed so far, nothing lost. Check the logs before running again.`);
          } catch (e) {}
        }
        break;
      }

      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }

    console.log(`[Knox][ARCHIVAL] Complete. Real: ${totals.real}, RP: ${totals.rp}, Flagged: ${totals.flagged}, Failed: ${totals.failed}`);

    if (discord && notifyChannelId) {
      try {
        const channel = await discord.channels.fetch(notifyChannelId);
        if (channel) {
          await channel.send(
            `Archival migration complete. 🔥\n\n` +
            `**${totals.real}** real memories moved into the graph\n` +
            `**${totals.rp}** creative-writing pieces kept separate as stories\n` +
            `**${totals.flagged}** flagged for your review\n` +
            (totals.failed ? `**${totals.failed}** failed to process — check the logs\n` : '') +
            `\nSame review system as before — say "show flagged memories" whenever you're ready.`
          );
        }
      } catch (e) { console.log('[Knox][ARCHIVAL] Could not send completion message:', e.message); }
    }
  } catch (e) {
    console.log('[Knox][ARCHIVAL] Fatal error:', e.message);
  } finally {
    archivalMigrationInProgress = false;
  }
}

async function resetArchivalMigration() {
  const result = await pgPool.query(`
    UPDATE archival_memories
    SET migrated_at = NULL
    WHERE migrated_at IS NOT NULL
    AND id NOT IN (SELECT source_memory_id FROM memory_review_flags WHERE source_table = 'archival_memories')
  `);
  return result.rowCount;
}

async function getArchivalMigrationStatus() {
  const totalResult = await pgPool.query(`SELECT COUNT(*) FROM archival_memories`);
  const migratedResult = await pgPool.query(`SELECT COUNT(*) FROM archival_memories WHERE migrated_at IS NOT NULL`);
  const pendingResult = await pgPool.query(`SELECT COUNT(*) FROM archival_memories WHERE migrated_at IS NULL`);
  return {
    total: parseInt(totalResult.rows[0].count, 10),
    migrated: parseInt(migratedResult.rows[0].count, 10),
    pending: parseInt(pendingResult.rows[0].count, 10)
  };
}

async function resetMigration() {
  // Only reset items that failed — leave anything already correctly flagged
  // (which doesn't need an embedding) untouched, so we don't create duplicate flags.
  const result = await pgPool.query(`
    UPDATE memories
    SET migrated_at = NULL
    WHERE migrated_at IS NOT NULL
    AND id::text NOT IN (SELECT source_memory_id FROM memory_review_flags)
  `);
  return result.rowCount;
}

async function getMigrationStatus() {
  const totalResult = await pgPool.query(`SELECT COUNT(*) FROM memories`);
  const migratedResult = await pgPool.query(`SELECT COUNT(*) FROM memories WHERE migrated_at IS NOT NULL`);
  const pendingResult = await pgPool.query(`SELECT COUNT(*) FROM memories WHERE migrated_at IS NULL`);
  const flaggedPendingResult = await pgPool.query(`SELECT COUNT(*) FROM memory_review_flags WHERE status = 'pending'`);
  const flaggedTotalResult = await pgPool.query(`SELECT COUNT(*) FROM memory_review_flags`);

  return {
    total: parseInt(totalResult.rows[0].count, 10),
    migrated: parseInt(migratedResult.rows[0].count, 10),
    pending: parseInt(pendingResult.rows[0].count, 10),
    flaggedPending: parseInt(flaggedPendingResult.rows[0].count, 10),
    flaggedTotal: parseInt(flaggedTotalResult.rows[0].count, 10)
  };
}


// ─── FIX ARCHIVE DATES IN THE GRAPH ────────────────────────────────────────────
// Early archive migration stamped graph nodes with the row's created_at (the
// import date) instead of the original timestamp, so old memories show up as
// March/April 2026. This re-stamps them from the real timestamp. It touches
// ONLY the created_at property — no classification, no embeddings, no LLM —
// and keeps the old value in imported_created_at so it's reversible.
// apply=false is a dry run that changes nothing.
async function fixArchiveDates(apply) {
  const { rows } = await pgPool.query(`SELECT id, "timestamp" AS ts FROM archival_memories`);
  const items = [];
  let undecodable = 0;
  for (const r of rows) {
    const d = decodeArchivalTimestamp(r.ts);
    if (!d) { undecodable++; continue; }
    items.push({ id: 'archival_' + String(r.id), iso: d.toISOString() });
  }

  const driver = neo4jMemory.getDriver();
  const stats = { archiveRows: rows.length, undecodable, found: 0, needChange: 0, changed: 0, byMonth: {}, samples: [] };
  const CHUNK = 500;

  for (const label of ['Memory', 'Story']) {
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const session = driver.session();
      try {
        const found = await session.run(
          `UNWIND $rows AS r MATCH (n:${label} {id: r.id}) RETURN r.id AS id, r.iso AS iso, toString(n.created_at) AS cur`,
          { rows: chunk }
        );
        const changing = [];
        for (const rec of found.records) {
          stats.found++;
          const cur = rec.get('cur'), iso = rec.get('iso');
          if (!cur || cur.slice(0, 10) !== iso.slice(0, 10)) {
            stats.needChange++;
            changing.push({ id: rec.get('id'), iso });
            const ym = iso.slice(0, 7);
            stats.byMonth[ym] = (stats.byMonth[ym] || 0) + 1;
            if (stats.samples.length < 3) stats.samples.push({ id: rec.get('id'), from: cur, to: iso });
          }
        }
        if (apply && changing.length) {
          await session.run(
            `UNWIND $rows AS r MATCH (n:${label} {id: r.id})
             SET n.imported_created_at = coalesce(n.imported_created_at, toString(n.created_at)), n.created_at = r.iso`,
            { rows: changing }
          );
          stats.changed += changing.length;
        }
      } finally { await session.close(); }
    }
  }
  return stats;
}

module.exports = {
  fixArchiveDates,
  runMemoryMigration,
  getPendingFlags,
  getPendingFlagCount,
  confirmDeleteFlag,
  confirmDeleteAllFlags,
  dismissFlag,
  resetMigration,
  getMigrationStatus,
  getDeletedFlags,
  getDeletedFlagCount,
  restoreFlag,
  restoreAllDeletedFlags,
  runArchivalMigration,
  resetArchivalMigration,
  getArchivalMigrationStatus
};