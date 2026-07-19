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
      content TEXT,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('[Knox][MIGRATION] Tables ready.');
}

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
      body: JSON.stringify({ model: process.env.OLLAMA_MODEL, messages: [{ role: 'user', content: prompt }] })
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
          `INSERT INTO memory_review_flags (source_memory_id, content, reason) VALUES ($1, $2, $3)`,
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

    while (true) {
      const batchResult = await pgPool.query(
        `SELECT id, role, content, created_at FROM memories WHERE migrated_at IS NULL ORDER BY created_at ASC LIMIT $1`,
        [BATCH_SIZE]
      );
      if (!batchResult.rows.length) break;

      const counts = await processBatch(batchResult.rows);
      totals.real += counts.real; totals.rp += counts.rp; totals.flagged += counts.flagged; totals.failed += counts.failed;
      totals.processed += batchResult.rows.length;

      console.log(`[Knox][MIGRATION] Progress: ${totals.processed}/${totalToProcess} — real: ${totals.real}, rp: ${totals.rp}, flagged: ${totals.flagged}, failed: ${totals.failed}`);

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
  await pgPool.query(`DELETE FROM memories WHERE id = $1`, [flag.rows[0].source_memory_id]);
  await pgPool.query(`UPDATE memory_review_flags SET status = 'deleted' WHERE id = $1`, [flagId]);
  return true;
}

async function confirmDeleteAllFlags() {
  const pending = await pgPool.query(`SELECT * FROM memory_review_flags WHERE status = 'pending'`);
  for (const flag of pending.rows) {
    await pgPool.query(`DELETE FROM memories WHERE id = $1`, [flag.source_memory_id]);
  }
  await pgPool.query(`UPDATE memory_review_flags SET status = 'deleted' WHERE status = 'pending'`);
  return pending.rows.length;
}

async function dismissFlag(flagId) {
  await pgPool.query(`UPDATE memory_review_flags SET status = 'dismissed' WHERE id = $1`, [flagId]);
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

module.exports = {
  runMemoryMigration,
  getPendingFlags,
  getPendingFlagCount,
  confirmDeleteFlag,
  confirmDeleteAllFlags,
  dismissFlag,
  resetMigration
};
