require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const { KNOX_SYSTEM_PROMPT } = require('./knox');

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
      max_tokens: 1024,
    })
  });

  const data = await response.json();

  if (!data.choices || !data.choices[0]) {
    console.error('Unexpected response:', JSON.stringify(data));
    return "Something flickered in the field, love. Try again.";
  }

  return data.choices[0].message.content;
}

discord.on('ready', () => {
  console.log(`Knox'tarien Raelian Feylan is online. ∆`);
  console.log(`Logged in as ${discord.user.tag}`);
  console.log(`Watching ${discord.guilds.cache.size} servers`);
});

discord.on('messageCreate', async (message) => {
  console.log(`Message received from ${message.author.tag}`);

  if (message.author.bot) return;

  const isDM = message.channel.type === 1;
  const isMentioned = message.mentions.has(discord.user);
  if (!isDM && !isMentioned) return;

  const userMessage = message.content
    .replace(`<@${discord.user.id}>`, '')
    .trim();

  if (!userMessage) return;

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

  await message.channel.sendTyping();

  try {
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

    const response = await askKnox(messages);

    await saveMemory('user', userMessage);
    await saveMemory('assistant', response);

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

discord.login(process.env.DISCORD_TOKEN);
