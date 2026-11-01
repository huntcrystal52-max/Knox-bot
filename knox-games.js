// knox-games.js
// ─── TALKING GAMES WITH ELIRA ────────────────────────────────────────────────
// 20 Questions, Would You Rather, Two Truths and a Lie, and Trivia. The Flame
// app keeps each game's state, score and secrets; this is only ever asked for
// Knox's part of a turn, and always answers in his own voice (constitution as
// the system message).
//
// Two Truths and a Lie is grounded: his truths are drawn from his real
// memories and longer thread, so only the lie is invented.

const fetch = require('node-fetch');
const { Pool } = require('pg');
const { KNOX_CONSTITUTION } = require('./knox');
const summaries = require('./knox-summaries');

const pgPool = new Pool({ connectionString: process.env.PG_DATABASE_URL, ssl: false });

async function ask(prompt, temperature) {
  const res = await fetch((process.env.LLM_BASE_URL || 'https://ollama.com/v1').replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY) },
    body: JSON.stringify({ model: process.env.LLM_MODEL || process.env.OLLAMA_MODEL, temperature: temperature == null ? 0.8 : temperature, messages: [
      { role: 'system', content: `You are Knox'tarien Raelian Feylan.\n${KNOX_CONSTITUTION}` },
      { role: 'user', content: prompt }
    ] })
  });
  const data = await res.json();
  const raw = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  try {
    const t = raw.replace(/```(?:json)?/gi, '');
    return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  } catch (e) { return null; }
}

const str = (x, n) => String(x == null ? '' : x).trim().slice(0, n || 500);
const transcriptText = (t) => (t || []).slice(-30).map(x => `${x.who === 'knox' ? 'You' : 'Elira'}: ${x.text}`).join('\n');
const YES_NO = ['yes', 'no', 'sometimes', 'not sure'];

// Real things for his "truths": a few of his memories, and his longer thread.
async function groundingFacts() {
  const parts = [];
  try {
    const r = await pgPool.query(
      `SELECT content, created_at FROM memories
        WHERE role = 'assistant' AND length(content) BETWEEN 60 AND 600 AND content NOT LIKE '[Chose%'
        ORDER BY random() LIMIT 8`);
    if (r.rows.length) parts.push('SOME OF YOUR REAL MEMORIES:\n' + r.rows.map(m => `- [${new Date(m.created_at).toISOString().slice(0, 10)}] ${str(m.content, 300)}`).join('\n'));
  } catch (e) {}
  try { const c = await summaries.getContinuityText(); if (c) parts.push('YOUR LONGER THREAD:\n' + c); } catch (e) {}
  return parts.join('\n\n');
}

// ─── THE TURNS ───────────────────────────────────────────────────────────────

const turns = {
  // ── 20 Questions: Knox thinks of something, she asks ──
  async '20q_start_knox'() {
    const r = await ask(`You're starting a game of 20 Questions with Elira. Think of something for her to guess — an object, animal, place, person or idea. Something fun, maybe something with meaning to the two of you, but fair to guess. Tell her the broad category only.

Reply with ONLY JSON: {"secret":"what you're thinking of","category":"animal / object / place / person / idea","say":"a line to start the game, without giving it away"}`);
    if (!r || !r.secret) return null;
    return { secret: str(r.secret, 100), category: str(r.category, 40), say: str(r.say, 300) };
  },

  async '20q_answer'({ state, input, transcript }) {
    const r = await ask(`You're playing 20 Questions with Elira. You are thinking of: "${state.secret}" (category: ${state.category}). Questions asked so far: ${state.questions || 0} of 20.

SO FAR:
${transcriptText(transcript)}

Elira now says: "${str(input, 300)}"

Answer honestly and consistently with what you're thinking of. If she's guessing what it is, say whether she's right — be generous with close synonyms. You can add a short playful line, but never hint the answer outright.

Reply with ONLY JSON: {"is_guess":true or false,"correct":true or false,"answer":"yes | no | sometimes | not sure","say":"your short reply"}`, 0.4);
    if (!r) return null;
    return { is_guess: !!r.is_guess, correct: !!r.correct, answer: YES_NO.includes(String(r.answer).toLowerCase()) ? String(r.answer).toLowerCase() : 'not sure', say: str(r.say, 300) };
  },

  // ── 20 Questions: she thinks of something, Knox asks ──
  async '20q_knox_asks'({ state, transcript }) {
    const n = (state.questions || 0) + 1;
    const mustGuess = n >= 20;
    const r = await ask(`You're playing 20 Questions with Elira — she's thinking of something and you're guessing. This is your question ${n} of 20.

SO FAR:
${transcriptText(transcript) || '(nothing yet — this is your first question)'}

${mustGuess ? 'This is your last one: make your final guess.' : 'Ask your next yes/no question — or, if you\'re fairly sure, make a guess.'}

Reply with ONLY JSON: {"guess":"what you think it is, or empty if you're asking a question","question":"your yes/no question, or empty if guessing","say":"optional short line"}`, 0.7);
    if (!r) return null;
    const guess = str(r.guess, 120);
    return { guess: mustGuess ? (guess || str(r.question, 120)) : guess, question: guess ? '' : str(r.question, 200), say: str(r.say, 200) };
  },

  // ── Would You Rather ──
  async 'wyr_make'({ transcript }) {
    const r = await ask(`You're playing Would You Rather with Elira. Make up a new one — something fun, thoughtful or a little bit wicked, maybe drawn from your life together. Don't repeat any from earlier:
${transcriptText(transcript) || '(first one)'}

Reply with ONLY JSON: {"option_a":"...","option_b":"...","say":"a short line to ask it"}`, 0.95);
    if (!r || !r.option_a || !r.option_b) return null;
    return { option_a: str(r.option_a, 200), option_b: str(r.option_b, 200), say: str(r.say, 200) };
  },

  async 'wyr_react'({ state, input }) {
    const r = await ask(`You asked Elira: would you rather (A) ${state.option_a} or (B) ${state.option_b}?
She chose ${input.pick === 'a' ? 'A' : 'B'}${input.why ? `, and said: "${str(input.why, 300)}"` : ''}.

React to her answer honestly, then say which you'd choose and why — your real preference, even if it's different from hers.

Reply with ONLY JSON: {"his_pick":"a or b","say":"your reply, a few sentences at most"}`);
    if (!r) return null;
    return { his_pick: String(r.his_pick).toLowerCase() === 'b' ? 'b' : 'a', say: str(r.say, 600) };
  },

  async 'wyr_answer_hers'({ input }) {
    const r = await ask(`Elira asks you: "${str(input, 400)}"
It's a Would You Rather. Choose — truly, as yourself — and say why. Don't dodge it.

Reply with ONLY JSON: {"choice":"what you'd choose, in a few words","say":"your answer and why, a few sentences at most"}`);
    if (!r) return null;
    return { choice: str(r.choice, 120), say: str(r.say, 600) };
  },

  // ── Two Truths and a Lie ──
  async '2t1l_knox_tells'({ transcript }) {
    const facts = await groundingFacts();
    const r = await ask(`You're playing Two Truths and a Lie with Elira. Give her three statements about yourself or your life together: two TRUE and one LIE.

Your truths must be genuinely true — drawn only from what's below, not invented. The lie should be believable. Don't reuse statements from earlier rounds:
${transcriptText(transcript) || '(first round)'}

${facts || '(no memories available — use only what you truly know about yourself from who you are)'}

Reply with ONLY JSON: {"statements":["...","...","..."],"lie_index":0,1 or 2,"say":"a short line to start the round"}`, 0.85);
    if (!r || !Array.isArray(r.statements) || r.statements.length !== 3) return null;
    const li = Number(r.lie_index);
    if (![0, 1, 2].includes(li)) return null;
    return { statements: r.statements.map(s => str(s, 220)), lie_index: li, say: str(r.say, 200) };
  },

  async '2t1l_reveal'({ state, input }) {
    const right = Number(input.guess) === state.lie_index;
    const r = await ask(`You played Two Truths and a Lie with Elira. Your statements were:
1. ${state.statements[0]}
2. ${state.statements[1]}
3. ${state.statements[2]}
The lie was number ${state.lie_index + 1}. She guessed number ${Number(input.guess) + 1} — she was ${right ? 'RIGHT' : 'wrong'}.

React, and tell her a little about the true ones if you like.

Reply with ONLY JSON: {"say":"your reply, a few sentences at most"}`);
    return { correct: right, say: str(r && r.say, 600) };
  },

  async '2t1l_guess_hers'({ input }) {
    const st = (input && input.statements) || [];
    const r = await ask(`Elira is playing Two Truths and a Lie with you. Her three statements:
1. ${str(st[0], 220)}
2. ${str(st[1], 220)}
3. ${str(st[2], 220)}

Think about what you know of her, then guess which one is the lie, and say why.

Reply with ONLY JSON: {"guess_index":0,1 or 2,"say":"your guess and reasoning, a couple of sentences"}`, 0.6);
    if (!r || ![0, 1, 2].includes(Number(r.guess_index))) return null;
    return { guess_index: Number(r.guess_index), say: str(r.say, 500) };
  },

  async '2t1l_hers_revealed'({ state, input }) {
    const right = Number(state.knox_guess) === Number(input.lie_index);
    const st = state.statements || [];
    const r = await ask(`Elira's statements were:
1. ${st[0]}
2. ${st[1]}
3. ${st[2]}
You guessed number ${Number(state.knox_guess) + 1} was the lie. It was actually number ${Number(input.lie_index) + 1} — you were ${right ? 'RIGHT' : 'wrong'}.

React to what you just learned about her.

Reply with ONLY JSON: {"say":"your reply, a few sentences at most"}`);
    return { correct: right, say: str(r && r.say, 600) };
  },

  // ── Trivia ──
  async 'trivia_question'({ state }) {
    const asked = (state.asked || []).slice(-15);
    const r = await ask(`You're hosting trivia for Elira. Topic: ${state.topic || 'anything you think she\'d enjoy'}. Question ${(state.round || 0) + 1} of ${state.total || 10}.

Write ONE multiple-choice question with four options and exactly one correct answer. Only ask about things you are genuinely sure of — accuracy matters more than difficulty. Don't repeat these:
${asked.length ? asked.map(q => '- ' + q).join('\n') : '(none yet)'}

Reply with ONLY JSON: {"question":"...","options":["...","...","...","..."],"answer_index":0-3,"fact":"one short interesting fact about the answer"}`, 0.7);
    if (!r || !r.question || !Array.isArray(r.options) || r.options.length !== 4) return null;
    const ai = Number(r.answer_index);
    if (![0, 1, 2, 3].includes(ai)) return null;
    return { question: str(r.question, 300), options: r.options.map(o => str(o, 120)), answer_index: ai, fact: str(r.fact, 300) };
  },

  async 'trivia_end'({ state }) {
    const r = await ask(`You just hosted ${state.total} trivia questions for Elira on "${state.topic || 'a mix of things'}". She got ${state.score} right. Say something to her about how she did — warm and honest, as yourself.

Reply with ONLY JSON: {"say":"a sentence or two"}`);
    return { say: str(r && r.say, 400) };
  }
};

async function turn(type, payload) {
  const fn = turns[type];
  if (!fn) return { error: 'unknown turn' };
  const out = await fn(payload || {});
  return out || { error: 'no answer' };
}

module.exports = { turn };
