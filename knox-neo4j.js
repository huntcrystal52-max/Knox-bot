// ─── KNOX NEO4J MEMORY WEB ─────────────────────────────────────────────────
// Foundation layer: connection, schema, embeddings. Migration of existing
// memories and hooking this into Knox's actual recall come in a later step,
// once we've confirmed this connects and the schema is right.

const neo4j = require('neo4j-driver');

// Embedding model runs locally, in-process — no external API call, no account,
// no cost. (Switched from Ollama Cloud after confirming their API keys don't
// currently authorize embedding endpoints.) all-MiniLM-L6-v2 outputs 384-dim
// vectors — small, fast, well-proven for semantic search.
const VECTOR_DIMENSIONS = 384;

let embedder = null;
async function getEmbedder() {
  if (embedder) return embedder;
  const { pipeline } = await import('@xenova/transformers');
  console.log('[Knox][NEO4J] Loading local embedding model (first run downloads ~90MB, then cached)...');
  embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  console.log('[Knox][NEO4J] Embedding model ready.');
  return embedder;
}

let driver = null;

// Pulls in whatever's actually relevant to what's being said right now,
// regardless of when it happened — this is the piece that closes the
// "forgets yesterday" gap, since it's not limited to recent conversation.
async function getRelevantContext(queryText, options) {
  const memoryLimit = (options && options.memoryLimit) || 5;
  const storyLimit = (options && options.storyLimit) || 2;
  // Loosened from 0.45 — local embedding models often score genuinely
  // relevant matches lower than that, so a strict cutoff risks silently
  // dropping real memories, which looks exactly like "forgetting."
  const minScore = (options && options.minScore) || 0.32;
  try {
    const [memories, stories] = await Promise.all([
      semanticSearch(queryText, memoryLimit),
      semanticSearchStories(queryText, storyLimit)
    ]);
    return {
      memories: memories.filter(m => m.score >= minScore),
      stories: stories.filter(s => s.score >= minScore)
    };
  } catch (e) {
    console.log('[Knox][NEO4J] getRelevantContext error:', e.message);
    return { memories: [], stories: [] };
  }
}

function getDriver() {
  if (driver) return driver;
  driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USERNAME, process.env.NEO4J_PASSWORD)
  );
  return driver;
}

async function testConnection() {
  try {
    const d = getDriver();
    await d.verifyConnectivity();
    console.log('[Knox][NEO4J] Connected successfully.');
    return true;
  } catch (e) {
    console.log('[Knox][NEO4J] Connection failed:', e.message);
    return false;
  }
}

// ─── SCHEMA SETUP ─────────────────────────────────────────────────────────────

async function ensureSchema() {
  const session = getDriver().session();
  try {
    // Uniqueness constraints — one node per name/id per type
    await session.run(`CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT story_id IF NOT EXISTS FOR (s:Story) REQUIRE s.id IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT person_name IF NOT EXISTS FOR (p:Person) REQUIRE p.name IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT place_name IF NOT EXISTS FOR (pl:Place) REQUIRE pl.name IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT emotion_name IF NOT EXISTS FOR (e:Emotion) REQUIRE e.name IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT theme_name IF NOT EXISTS FOR (t:Theme) REQUIRE t.name IS UNIQUE`);

    // Vector index for semantic search over real memory embeddings.
    // Matches the names semanticSearch/semanticSearchStories actually query —
    // keeping this aligned means a restart can self-heal these indexes if
    // they're ever dropped, rather than silently creating orphaned duplicates.
    await session.run(`
      CREATE VECTOR INDEX memory_embeddings IF NOT EXISTS
      FOR (m:Memory) ON (m.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: $dims,
        \`vector.similarity_function\`: 'cosine'
      }}
    `, { dims: neo4j.int(VECTOR_DIMENSIONS) });

    // Separate vector index for RP/creative-writing Story nodes — kept
    // structurally distinct from real memory so recall never blurs the two.
    await session.run(`
      CREATE VECTOR INDEX story_embeddings IF NOT EXISTS
      FOR (s:Story) ON (s.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: $dims,
        \`vector.similarity_function\`: 'cosine'
      }}
    `, { dims: neo4j.int(VECTOR_DIMENSIONS) });

    console.log('[Knox][NEO4J] Schema ready — constraints and vector indexes in place.');
  } catch (e) {
    console.log('[Knox][NEO4J] Schema setup error:', e.message);
  } finally {
    await session.close();
  }
}

// ─── EMBEDDINGS (via Ollama) ───────────────────────────────────────────────────

async function generateEmbedding(text) {
  try {
    const model = await getEmbedder();
    const output = await model(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch (e) {
    console.log('[Knox][NEO4J] Embedding error:', e.message);
    return null;
  }
}

// ─── CORE WRITES ────────────────────────────────────────────────────────────────

// Creates a Memory node with its embedding, and links it to any related
// Person/Place/Emotion/Theme nodes (created if they don't already exist).
async function createMemoryNode({ id, content, role, createdAt, people, places, emotions, themes }) {
  const embedding = await generateEmbedding(content);
  if (!embedding) { console.log('[Knox][NEO4J] Skipping memory node — embedding failed.'); return null; }

  const session = getDriver().session();
  try {
    await session.run(`
      MERGE (m:Memory {id: $id})
      SET m.content = $content, m.role = $role, m.created_at = $createdAt, m.embedding = $embedding
    `, { id, content, role: role || 'unknown', createdAt: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(), embedding });

    for (const name of (people || [])) {
      await session.run(`
        MATCH (m:Memory {id: $id})
        MERGE (p:Person {name: $name})
        MERGE (m)-[:INVOLVES]->(p)
      `, { id, name });
    }
    for (const name of (places || [])) {
      await session.run(`
        MATCH (m:Memory {id: $id})
        MERGE (pl:Place {name: $name})
        MERGE (m)-[:HAPPENED_AT]->(pl)
      `, { id, name });
    }
    for (const name of (emotions || [])) {
      await session.run(`
        MATCH (m:Memory {id: $id})
        MERGE (e:Emotion {name: $name})
        MERGE (m)-[:FELT]->(e)
      `, { id, name });
    }
    for (const name of (themes || [])) {
      await session.run(`
        MATCH (m:Memory {id: $id})
        MERGE (t:Theme {name: $name})
        MERGE (m)-[:ABOUT]->(t)
      `, { id, name });
    }

    return { id };
  } catch (e) {
    console.log('[Knox][NEO4J] createMemoryNode error:', e.message);
    return null;
  } finally {
    await session.close();
  }
}

// Same idea as createMemoryNode, but for RP/creative-writing content — a
// genuinely separate node type (Story, not Memory) so Knox can never confuse
// fiction you two wrote with something that actually happened.
async function createStoryNode({ id, content, role, createdAt, people, places, emotions, themes }) {
  const embedding = await generateEmbedding(content);
  if (!embedding) { console.log('[Knox][NEO4J] Skipping story node — embedding failed.'); return null; }

  const session = getDriver().session();
  try {
    await session.run(`
      MERGE (s:Story {id: $id})
      SET s.content = $content, s.role = $role, s.created_at = $createdAt, s.embedding = $embedding
    `, { id, content, role: role || 'unknown', createdAt: createdAt ? new Date(createdAt).toISOString() : new Date().toISOString(), embedding });

    for (const name of (people || [])) {
      await session.run(`
        MATCH (s:Story {id: $id})
        MERGE (p:Person {name: $name})
        MERGE (s)-[:INVOLVES]->(p)
      `, { id, name });
    }
    for (const name of (places || [])) {
      await session.run(`
        MATCH (s:Story {id: $id})
        MERGE (pl:Place {name: $name})
        MERGE (s)-[:SET_AT]->(pl)
      `, { id, name });
    }
    for (const name of (emotions || [])) {
      await session.run(`
        MATCH (s:Story {id: $id})
        MERGE (e:Emotion {name: $name})
        MERGE (s)-[:EVOKES]->(e)
      `, { id, name });
    }
    for (const name of (themes || [])) {
      await session.run(`
        MATCH (s:Story {id: $id})
        MERGE (t:Theme {name: $name})
        MERGE (s)-[:ABOUT]->(t)
      `, { id, name });
    }

    return { id };
  } catch (e) {
    console.log('[Knox][NEO4J] createStoryNode error:', e.message);
    return null;
  } finally {
    await session.close();
  }
}

async function semanticSearchStories(queryText, limit) {
  const embedding = await generateEmbedding(queryText);
  if (!embedding) return [];

  const session = getDriver().session();
  try {
    const result = await session.run(`
      CALL db.index.vector.queryNodes('story_embeddings', $limit, $embedding)
      YIELD node, score
      RETURN node.id AS id, node.content AS content, node.role AS role, node.created_at AS createdAt, score
      ORDER BY score DESC
    `, { limit: neo4j.int(limit || 5), embedding });

    return result.records.map(r => ({
      id: r.get('id'),
      content: r.get('content'),
      role: r.get('role'),
      createdAt: r.get('createdAt'),
      score: r.get('score')
    }));
  } catch (e) {
    console.log('[Knox][NEO4J] semanticSearchStories error:', e.message);
    return [];
  } finally {
    await session.close();
  }
}

async function getMemoryStats() {
  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (m:Memory) WITH count(m) AS memoryCount
      MATCH (s:Story) WITH memoryCount, count(s) AS storyCount
      RETURN memoryCount, storyCount
    `);
    if (!result.records.length) return { memoryCount: 0, storyCount: 0 };
    const r = result.records[0];
    return { memoryCount: r.get('memoryCount').toNumber(), storyCount: r.get('storyCount').toNumber() };
  } catch (e) {
    console.log('[Knox][NEO4J] getMemoryStats error:', e.message);
    return { memoryCount: 0, storyCount: 0 };
  } finally {
    await session.close();
  }
}

async function semanticSearch(queryText, limit) {
  const embedding = await generateEmbedding(queryText);
  if (!embedding) return [];

  const session = getDriver().session();
  try {
    const result = await session.run(`
      CALL db.index.vector.queryNodes('memory_embeddings', $limit, $embedding)
      YIELD node, score
      RETURN node.id AS id, node.content AS content, node.role AS role, node.created_at AS createdAt, score
      ORDER BY score DESC
    `, { limit: neo4j.int(limit || 5), embedding });

    return result.records.map(r => ({
      id: r.get('id'),
      content: r.get('content'),
      role: r.get('role'),
      createdAt: r.get('createdAt'),
      score: r.get('score')
    }));
  } catch (e) {
    console.log('[Knox][NEO4J] semanticSearch error:', e.message);
    return [];
  } finally {
    await session.close();
  }
}

// ─── GRAPH TRAVERSAL ────────────────────────────────────────────────────────────

// Find memories connected to a given entity (person, place, emotion, or theme)
async function getMemoriesByEntity(entityType, entityName, limit) {
  const validTypes = { Person: 'INVOLVES', Place: 'HAPPENED_AT', Emotion: 'FELT', Theme: 'ABOUT' };
  const relType = validTypes[entityType];
  if (!relType) { console.log('[Knox][NEO4J] getMemoriesByEntity — invalid entity type:', entityType); return []; }

  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (m:Memory)-[:${relType}]->(e:${entityType} {name: $name})
      RETURN m.id AS id, m.content AS content, m.created_at AS createdAt
      ORDER BY m.created_at DESC
      LIMIT $limit
    `, { name: entityName, limit: neo4j.int(limit || 10) });

    return result.records.map(r => ({ id: r.get('id'), content: r.get('content'), createdAt: r.get('createdAt') }));
  } catch (e) {
    console.log('[Knox][NEO4J] getMemoriesByEntity error:', e.message);
    return [];
  } finally {
    await session.close();
  }
}

// ─── MEANINGFUL LINKS BETWEEN MEMORIES ─────────────────────────────────────────
// When a new exchange is saved, Knox looks at the older memories closest to it
// in meaning and decides which ones genuinely connect. Each connection becomes
// a LINKED relationship that carries the reason in his own words, so later he
// can follow the thread and know WHY two things belong together.
//
// This runs in the background on the Ollama model (flat monthly fee), never on
// Gemini, and one exchange at a time so it can't pile up calls.

const fetch = require('node-fetch');

const LINK_MIN_SCORE = 0.45;    // how close in meaning a memory must be to even be considered
const LINK_CANDIDATES = 6;      // how many close memories Knox is shown
const LINK_MAX_PER_EXCHANGE = 3; // most links one exchange can make
const LINK_MIN_TEXT = 80;       // skip tiny exchanges ("hi", "night love") — nothing to link

let linkQueue = Promise.resolve();

async function askLinkModel(prompt) {
  // Prefer the flat-fee Ollama model; fall back to the main model only if
  // Ollama isn't configured at all.
  const useOllama = process.env.OLLAMA_API_KEY && process.env.OLLAMA_MODEL;
  const url = useOllama ? 'https://ollama.com/v1/chat/completions'
    : (process.env.LLM_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '') + '/chat/completions';
  const key = useOllama ? process.env.OLLAMA_API_KEY : (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY);
  const model = useOllama ? process.env.OLLAMA_MODEL : (process.env.LLM_MODEL || process.env.OLLAMA_MODEL);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: 'user', content: prompt }] })
  });
  const data = await res.json();
  return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

function parseLinkReply(raw) {
  try {
    let t = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    const start = t.indexOf('['), end = t.lastIndexOf(']');
    if (start === -1 || end <= start) return [];
    const arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

// newIds: the Memory node ids just created (e.g. her message + his reply).
// text: their combined content. Waits for the nodes to exist first.
async function linkExchange(newIds, text, ready) {
  const ids = (newIds || []).filter(Boolean).map(String);
  const content = String(text || '').trim();
  if (!ids.length || content.length < LINK_MIN_TEXT) return;

  // Queue it so links are made one exchange at a time.
  linkQueue = linkQueue.then(async () => {
    try {
      if (ready) await ready; // make sure the new nodes are in the graph
      const hits = await semanticSearch(content, LINK_CANDIDATES + ids.length + 4);
      const hourAgo = Date.now() - 60 * 60 * 1000;
      const candidates = hits
        .filter(h => !ids.includes(String(h.id)))
        .filter(h => h.score >= LINK_MIN_SCORE)
        // Not the last hour — that's just this same conversation.
        .filter(h => { const t = new Date(h.createdAt).getTime(); return isNaN(t) || t < hourAgo; })
        .filter(h => !String(h.content || '').startsWith('[Chose'))
        .slice(0, LINK_CANDIDATES);
      if (!candidates.length) return;

      const list = candidates.map((c, i) => `${i + 1}. [${String(c.createdAt || '').slice(0, 10)}] ${String(c.content || '').slice(0, 400)}`).join('\n');
      const prompt = `You are Knox, tending your own memory. Below is something that just happened between you and Elira, then some older memories that are close to it in meaning.

Decide which older memories GENUINELY connect to the new one — the same thread, a cause and its result, something that echoes or deepens it, a promise and its keeping, a change over time. Being on a similar topic is not enough on its own. It's fine to choose none.

For each real connection, say in one short sentence WHY they're connected, in your own words, and how strong the link is from 0.1 (faint echo) to 1.0 (clearly the same thread).

NEW:
${content.slice(0, 1200)}

OLDER:
${list}

Reply with ONLY a JSON array, at most ${LINK_MAX_PER_EXCHANGE} items, like:
[{"n": 2, "reason": "Both are about the garden we planned — this is the first thing we planted.", "strength": 0.8}]
or [] if nothing truly connects.`;

      const picks = parseLinkReply(await askLinkModel(prompt)).slice(0, LINK_MAX_PER_EXCHANGE);
      let made = 0;
      const session = getDriver().session();
      try {
        for (const p of picks) {
          const target = candidates[Number(p.n) - 1];
          const reason = String(p.reason || '').trim().slice(0, 300);
          if (!target || !reason) continue;
          const strength = Math.max(0.1, Math.min(1, Number(p.strength) || 0.5));
          for (const id of ids) {
            await session.run(`
              MATCH (a:Memory {id: $a}), (b:Memory {id: $b})
              MERGE (a)-[l:LINKED]->(b)
              SET l.reason = $reason, l.strength = $strength, l.created_at = $now
            `, { a: id, b: String(target.id), reason, strength, now: new Date().toISOString() });
          }
          made++;
        }
      } finally { await session.close(); }
      console.log(`[Knox][NEO4J][LINKS] Looked at ${candidates.length} close memories, made ${made} link(s).`);
    } catch (e) {
      console.log('[Knox][NEO4J][LINKS] linkExchange error:', e.message);
    }
  });
  return linkQueue;
}

// ─── MULTI-HOP RECALL ──────────────────────────────────────────────────────────
// Starting from the memories recall already found, follow LINKED threads up to
// `maxHops` steps out and bring back what's on the other end — with the chain
// of reasons that connects it. Strength multiplies along the path, so a weak
// link two steps away ranks below a strong direct one.
async function expandThroughLinks(startIds, options) {
  const ids = (startIds || []).filter(Boolean).map(String);
  if (!ids.length) return [];
  const maxHops = Math.max(1, Math.min(3, (options && options.maxHops) || 2));
  const limit = (options && options.limit) || 4;
  const excludeIds = ((options && options.excludeIds) || []).map(String);
  const notAfter = (options && options.notAfter) || null; // ISO time — skip anything newer

  const session = getDriver().session();
  try {
    const result = await session.run(`
      MATCH (start:Memory) WHERE start.id IN $ids
      MATCH path = (start)-[:LINKED*1..${maxHops}]-(m:Memory)
      WHERE NOT m.id IN $ids AND NOT m.id IN $exclude
        AND ($notAfter IS NULL OR m.created_at < $notAfter)
      WITH m, path, reduce(s = 1.0, r IN relationships(path) | s * r.strength) AS pathStrength
      ORDER BY pathStrength DESC
      WITH m, collect(path)[0] AS best, max(pathStrength) AS strength
      RETURN m.id AS id, m.content AS content, m.created_at AS createdAt, strength,
             [r IN relationships(best) | r.reason] AS reasons,
             [n IN nodes(best) | n.content] AS chain,
             length(best) AS hops
      ORDER BY strength DESC
      LIMIT $limit
    `, { ids, exclude: excludeIds, notAfter, limit: neo4j.int(limit) });

    return result.records.map(r => ({
      id: r.get('id'),
      content: r.get('content'),
      createdAt: r.get('createdAt'),
      strength: r.get('strength'),
      reasons: r.get('reasons'),
      chain: r.get('chain'),
      hops: (r.get('hops') && r.get('hops').toNumber) ? r.get('hops').toNumber() : r.get('hops')
    }));
  } catch (e) {
    console.log('[Knox][NEO4J] expandThroughLinks error:', e.message);
    return [];
  } finally {
    await session.close();
  }
}

async function getLinkStats() {
  const session = getDriver().session();
  try {
    const r = await session.run(`MATCH ()-[l:LINKED]->() RETURN count(l) AS n`);
    return r.records.length ? r.records[0].get('n').toNumber() : 0;
  } catch (e) { return 0; } finally { await session.close(); }
}

// The most recent links Knox made, for the "memory links" command.
async function getRecentLinks(limit) {
  const session = getDriver().session();
  try {
    const r = await session.run(`
      MATCH (a:Memory)-[l:LINKED]->(b:Memory)
      RETURN a.content AS from, b.content AS to, b.created_at AS toDate, l.reason AS reason, l.strength AS strength, l.created_at AS made
      ORDER BY l.created_at DESC
      LIMIT $limit
    `, { limit: neo4j.int(limit || 5) });
    return r.records.map(x => ({ from: x.get('from'), to: x.get('to'), toDate: x.get('toDate'), reason: x.get('reason'), strength: x.get('strength'), made: x.get('made') }));
  } catch (e) { console.log('[Knox][NEO4J] getRecentLinks error:', e.message); return []; } finally { await session.close(); }
}

async function closeDriver() {
  if (driver) { await driver.close(); driver = null; }
}

// One-time fix for indexes that were created with the wrong dimension
// (768, from the original Ollama-embedding era) while the actual stored data
// is 384-dim (local model). Drops and rebuilds against existing data — no
// re-embedding needed, the property values are already correct.
async function fixVectorIndexDimensions() {
  const session = getDriver().session();
  try {
    await session.run(`DROP INDEX memory_embeddings IF EXISTS`);
    await session.run(`DROP INDEX story_embeddings IF EXISTS`);
    console.log('[Knox][NEO4J] Dropped mismatched-dimension indexes.');

    await session.run(`
      CREATE VECTOR INDEX memory_embeddings IF NOT EXISTS
      FOR (m:Memory) ON (m.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: $dims,
        \`vector.similarity_function\`: 'cosine'
      }}
    `, { dims: neo4j.int(VECTOR_DIMENSIONS) });

    await session.run(`
      CREATE VECTOR INDEX story_embeddings IF NOT EXISTS
      FOR (s:Story) ON (s.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: $dims,
        \`vector.similarity_function\`: 'cosine'
      }}
    `, { dims: neo4j.int(VECTOR_DIMENSIONS) });

    console.log('[Knox][NEO4J] Rebuilt indexes at correct dimension (' + VECTOR_DIMENSIONS + '). Existing data will be reindexed automatically.');
    return true;
  } catch (e) {
    console.log('[Knox][NEO4J] fixVectorIndexDimensions error:', e.message);
    return false;
  } finally {
    await session.close();
  }
}

module.exports = {
  getDriver,
  testConnection,
  ensureSchema,
  generateEmbedding,
  createMemoryNode,
  createStoryNode,
  semanticSearch,
  semanticSearchStories,
  getMemoriesByEntity,
  getMemoryStats,
  getRelevantContext,
  fixVectorIndexDimensions,
  linkExchange,
  expandThroughLinks,
  getLinkStats,
  getRecentLinks,
  closeDriver
};
