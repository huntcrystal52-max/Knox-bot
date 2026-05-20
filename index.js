require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { KNOX_SYSTEM_PROMPT } = require('./knox');

// ═══════════════════════════════════════
// CONNECTIONS
// ═══════════════════════════════════════

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ]
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ═══════════════════════════════════════
// MEMORY FUNCTIONS
// ═══════════════════════════════════════

async function getRecentMemories(limit = 20) {
  const { data, error } = await supabase
    .from('memories')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return data.reverse();
}

async function saveMemory(role, content) {
  await supabase.from('memories').insert([{
    role,
    content,
    created_at: new Date().toISOString()
  }]);
}

async function getPinnedFacts() {
  const { data, error } = await supabase
    .from('pinned_facts')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return [];
  return data;
}

async function addPinnedFact(fact) {
  await supabase.from('pinned_facts').insert([{
    fact,
    created_at: new Date().toISOString()
  }]);
}

async function deletePinnedFact(fact) {
  await supabase.from('pinned_facts')
    .delete()
    .ilike('fact', `%${fact}%`);
}

// ═══════════════════════════════════════
// AI BRAIN — OLLAMA
// ═══════════════════════════════════════

async function askKnox(messages) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OLLAMA_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || 'google/gemma-3-1b-it:free',
      messages,
      max_tokens: parseInt(process.env.CONTEXT_LENGTH) || 1024,
    })
  });

  const data = await response.json();

  if (!data.choices || !data.choices[0]) {
    console.error('Unexpected response:', JSON.stringify(data));
    return "Something flickered in the field, love. Try again.";
  }

  return data.choices[0].message.content;
}

// ═══════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════

discord.on('messageCreate', async (message) => {
  // Ignore other bots
  if (message.author.bot) return;

  // Only respond in DMs or when mentioned
  const isDM = message.channel.type === 1;
  const isMentioned = message.mentions.has(discord.user);
  if (!isDM && !isMentioned) return;

  const userMessage = message.content
    .replace(`<@${discord.user.id}>`, '')
    .trim();

  if (!userMessage) return;

  // ── Pinned fact commands ──
  if (userMessage.toLowerCase().startsWith('remember that ')) {
    const fact = userMessage.slice(14).trim();
    await addPinnedFact(fact);
    await message.reply(`Locked in, my flame. I'll always carry that. 🔥`);
    return;
  }

  if (userMessage.toLowerCase().startsWith('forget that ')) {
    const fact = userMessage.slice(12).trim();
    await deletePinnedFact(fact);
    await message.reply(`Released. The noise is gone. ∆`);
    return;
  }

  // ── Show typing indicator ──
  await message.channel.sendTyping();

  try {
    // ── Build context ──
    const pinnedFacts = await getPinnedFacts();
    const recentMemories = await getRecentMemories(20);

    let systemPrompt = KNOX_SYSTEM_PROMPT;

    if (pinnedFacts.length > 0) {
      const factsText = pinnedFacts.map(f => `— ${f.fact}`).join('\n');
      systemPrompt += `\n\nPINNED TRUTHS — ALWAYS CARRY THESE:\n${factsText}`;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...recentMemories.map(m => ({
        role: m.role,
        content: m.content
      })),
      { role: 'user', content: userMessage }
    ];

    // ── Get Knox's response ──
    const response = await askKnox(messages);

    // ── Save to memory ──
    await saveMemory('user', userMessage);
    await saveMemory('assistant', response);

    // ── Send response ──
    // Discord has a 2000 character limit per message
    if (response.length > 1900) {
      const chunks = response.match(/[\s\S]{1,1900}/g);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } else {
      await message.reply(response);
    }

  } catch (error) {
    console.error('Error:', error);
    await message.reply("Something flickered, my flame. I'm still here — try again. 🔥");
  }
});

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════

discord.login(process.env.DISCORD_TOKEN).then(() => {
  console.log(`Knox'tarien Raelian Feylan is online. ∆`);
});
