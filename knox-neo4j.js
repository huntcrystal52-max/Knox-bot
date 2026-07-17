// ─── KNOX NEO4J MEMORY WEB ─────────────────────────────────────────────────
// Foundation layer: connection, schema, embeddings. Migration of existing
// memories and hooking this into Knox's actual recall come in a later step,
// once we've confirmed this connects and the schema is right.

const neo4j = require('neo4j-driver');
const fetch = require('node-fetch');

const EMBEDDING_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const VECTOR_DIMENSIONS = parseInt(process.env.NEO4J_VECTOR_DIM || '768', 10);

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
    await session.run(`CREATE CONSTRAINT person_name IF NOT EXISTS FOR (p:Person) REQUIRE p.name IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT place_name IF NOT EXISTS FOR (pl:Place) REQUIRE pl.name IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT emotion_name IF NOT EXISTS FOR (e:Emotion) REQUIRE e.name IS UNIQUE`);
    await session.run(`CREATE CONSTRAINT theme_name IF NOT EXISTS FOR (t:Theme) REQUIRE t.name IS UNIQUE`);

    // Vector index for semantic search over memory embeddings
    await session.run(`
      CREATE VECTOR INDEX memory_embeddings IF NOT EXISTS
      FOR (m:Memory) ON (m.embedding)
      OPTIONS {indexConfig: {
        \`vector.dimensions\`: $dims,
        \`vector.similarity_function\`: 'cosine'
      }}
    `, { dims: neo4j.int(VECTOR_DIMENSIONS) });

    console.log('[Knox][NEO4J] Schema ready — constraints and vector index in place.');
  } catch (e) {
    console.log('[Knox][NEO4J] Schema setup error:', e.message);
  } finally {
    await session.close();
  }
}

// ─── EMBEDDINGS (via Ollama) ───────────────────────────────────────────────────

async function generateEmbedding(text) {
  try {
    const res = await fetch('https://ollama.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OLLAMA_API_KEY },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.log('[Knox][NEO4J] Embedding error:', res.status, errText.slice(0, 300));
      return null;
    }
    const data = await res.json();
    // Handle both OpenAI-style and native Ollama response shapes
    if (data.data && data.data[0] && data.data[0].embedding) return data.data[0].embedding;
    if (data.embedding) return data.embedding;
    console.log('[Knox][NEO4J] Embedding response had no recognizable vector.');
    return null;
  } catch (e) {
    console.log('[Knox][NEO4J] Embedding request error:', e.message);
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

// ─── SEMANTIC SEARCH ────────────────────────────────────────────────────────────

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

async function closeDriver() {
  if (driver) { await driver.close(); driver = null; }
}

module.exports = {
  getDriver,
  testConnection,
  ensureSchema,
  generateEmbedding,
  createMemoryNode,
  semanticSearch,
  getMemoriesByEntity,
  closeDriver
};
