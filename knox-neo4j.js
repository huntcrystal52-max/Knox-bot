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
    // Named _v2 since the embedding model changed (Ollama Cloud -> local
    // model), and dimensions changed with it — old empty indexes are
    // harmless leftovers, no data was ever written to them.
    await session.run(`
      CREATE VECTOR INDEX memory_embeddings_v2 IF NOT EXISTS
      FOR (m:Memory) ON (m.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: $dims,
        \`vector.similarity_function\`: 'cosine'
      }}
    `, { dims: neo4j.int(VECTOR_DIMENSIONS) });

    // Separate vector index for RP/creative-writing Story nodes — kept
    // structurally distinct from real memory so recall never blurs the two.
    await session.run(`
      CREATE VECTOR INDEX story_embeddings_v2 IF NOT EXISTS
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
    `, { id, content, role: role || 'unknown', createdAt: createdAt || new Date().toISOString(), embedding });

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
    `, { id, content, role: role || 'unknown', createdAt: createdAt || new Date().toISOString(), embedding });

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
      CALL db.index.vector.queryNodes('story_embeddings_v2', $limit, $embedding)
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
      CALL db.index.vector.queryNodes('memory_embeddings_v2', $limit, $embedding)
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

async function closeDriver() {
  if (driver) { await driver.close(); driver = null; }
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
  closeDriver
};
