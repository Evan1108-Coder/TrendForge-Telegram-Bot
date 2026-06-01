const { Bot } = require('grammy');
const { chat, getAllModels, getAvailableModels } = require('./llm/providers');
const { loadPreferences, updatePreferences } = require('./preferences');
const { generateDailyReport } = require('./report');

async function explainError(err, context) {
  try {
    const available = getAvailableModels();
    const model = available[0];
    if (!model) return `❌ ${context} failed: ${err.message}`;

    const response = await chat(model, [
      { role: 'system', content: 'You are a helpful bot error explainer. When something goes wrong, explain clearly what happened and what the user can do about it. Be brief (2-3 sentences max). Be friendly and reassuring.' },
      { role: 'user', content: `The following error occurred while ${context}: ${err.message}\n\nError type: ${err.constructor.name}\nHTTP status: ${err.response?.status || 'N/A'}\n\nExplain what happened and suggest a fix.` },
    ]);
    return `⚠️ ${response}`;
  } catch {
    return `❌ ${context} failed: ${err.message}`;
  }
}

function createBot(token) {
  const bot = new Bot(token);
  const conversationHistory = new Map();

  function getHistory(chatId) {
    if (!conversationHistory.has(chatId)) {
      conversationHistory.set(chatId, []);
    }
    return conversationHistory.get(chatId);
  }

  function addToHistory(chatId, role, content) {
    const history = getHistory(chatId);
    history.push({ role, content });
    if (history.length > 20) history.splice(0, history.length - 20);
  }

  bot.command('start', async (ctx) => {
    console.log(`[START] User: ${ctx.from.first_name} (${ctx.from.id}), Chat ID: ${ctx.chat.id}`);
    await ctx.reply(
      '🔨 *Welcome to TrendForge!*\n\n' +
      'I watch GitHub Trending, Hacker News, Reddit, Product Hunt & Dev.to daily, then use AI to filter and generate personalized project ideas for you.\n\n' +
      '*Commands:*\n' +
      '/report — Get today\'s trend report now\n' +
      '/prefs — View your taste profile\n' +
      '/setinterests — Set your interests\n' +
      '/setlangs — Set preferred languages\n' +
      '/setmodel — Change LLM model\n' +
      '/models — List available models\n' +
      '/trending — Quick GitHub trending\n' +
      '/hn — Quick Hacker News top stories\n' +
      '/reddit — Quick Reddit hot posts\n' +
      '/ph — Quick Product Hunt today\n' +
      '/devto — Quick Dev.to top articles\n' +
      '/idea — Generate a project idea\n' +
      '/help — Show this help\n\n' +
      '_Or just chat with me naturally!_',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      '🔨 *TrendForge Commands*\n\n' +
      '*Data Sources:*\n' +
      '/report — Generate today\'s AI-powered trend report\n' +
      '/trending — Raw GitHub trending repos\n' +
      '/hn — Raw Hacker News top stories\n' +
      '/reddit — Reddit hot posts (programming)\n' +
      '/ph — Product Hunt launches today\n' +
      '/devto — Dev.to top articles\n\n' +
      '*Preferences:*\n' +
      '/prefs — View current preferences\n' +
      '/setinterests <comma-separated> — Update interests\n' +
      '/setlangs <comma-separated> — Update languages\n' +
      '/setmodel <model> — Change LLM model\n' +
      '/models — List all supported models\n\n' +
      '*Other:*\n' +
      '/idea <topic> — Generate a project idea\n\n' +
      '_You can also just chat naturally and I\'ll help with tech trends, ideas, and analysis._',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('report', async (ctx) => {
    await ctx.reply('⏳ Generating your daily report from 5 sources... This may take a moment.');
    try {
      const report = await generateDailyReport();
      await sendLongMessage(ctx, report);
    } catch (err) {
      console.error('[Bot] Report generation failed:', err);
      await ctx.reply(await explainError(err, 'generating your trend report'));
    }
  });

  bot.command('trending', async (ctx) => {
    const { fetchGitHubTrending } = require('./scrapers/github');
    await ctx.reply('⏳ Fetching GitHub trending...');
    try {
      const repos = await fetchGitHubTrending();
      if (repos.length === 0) {
        await ctx.reply('No trending repos found right now.');
        return;
      }
      let msg = '📦 *GitHub Trending Today*\n\n';
      repos.slice(0, 15).forEach((r, i) => {
        msg += `${i + 1}. *${r.name}* (${r.language})\n   ${r.description}\n   ⭐ ${r.totalStars} | ${r.starsToday}\n\n`;
      });
      await sendLongMessage(ctx, msg, 'Markdown');
    } catch (err) {
      console.error('[Bot] Trending fetch error:', err);
      await ctx.reply(await explainError(err, 'fetching GitHub trending repos'));
    }
  });

  bot.command('hn', async (ctx) => {
    const { fetchTopStories } = require('./scrapers/hackernews');
    await ctx.reply('⏳ Fetching Hacker News...');
    try {
      const stories = await fetchTopStories(15);
      if (stories.length === 0) {
        await ctx.reply('No stories found right now.');
        return;
      }
      let msg = '📰 *Hacker News Top Stories*\n\n';
      stories.forEach((s, i) => {
        msg += `${i + 1}. *${s.title}*\n   🔗 ${s.url}\n   👆 ${s.score} pts | 💬 ${s.comments}\n\n`;
      });
      await sendLongMessage(ctx, msg, 'Markdown');
    } catch (err) {
      console.error('[Bot] HN fetch error:', err);
      await ctx.reply(await explainError(err, 'fetching Hacker News stories'));
    }
  });

  bot.command('reddit', async (ctx) => {
    const { fetchRedditHot } = require('./scrapers/reddit');
    await ctx.reply('⏳ Fetching Reddit hot posts...');
    try {
      const posts = await fetchRedditHot();
      if (posts.length === 0) {
        await ctx.reply('No Reddit posts found right now.');
        return;
      }
      let msg = '🤖 *Reddit Hot Posts*\n\n';
      posts.slice(0, 15).forEach((p, i) => {
        msg += `${i + 1}. *r/${p.subreddit}* — ${p.title}\n   👆 ${p.score} | 💬 ${p.comments}\n\n`;
      });
      await sendLongMessage(ctx, msg, 'Markdown');
    } catch (err) {
      console.error('[Bot] Reddit fetch error:', err);
      await ctx.reply(await explainError(err, 'fetching Reddit posts'));
    }
  });

  bot.command('ph', async (ctx) => {
    const { fetchProductHunt } = require('./scrapers/producthunt');
    await ctx.reply('⏳ Fetching Product Hunt...');
    try {
      const products = await fetchProductHunt();
      if (products.length === 0) {
        await ctx.reply('No Product Hunt launches found right now.');
        return;
      }
      let msg = '🚀 *Product Hunt Today*\n\n';
      products.slice(0, 10).forEach((p, i) => {
        msg += `${i + 1}. *${p.name}*\n   ${p.tagline}\n   👆 ${p.votes} upvotes\n\n`;
      });
      await sendLongMessage(ctx, msg, 'Markdown');
    } catch (err) {
      console.error('[Bot] Product Hunt fetch error:', err);
      await ctx.reply(await explainError(err, 'fetching Product Hunt launches'));
    }
  });

  bot.command('devto', async (ctx) => {
    const { fetchDevToArticles } = require('./scrapers/devto');
    await ctx.reply('⏳ Fetching Dev.to top articles...');
    try {
      const articles = await fetchDevToArticles();
      if (articles.length === 0) {
        await ctx.reply('No Dev.to articles found right now.');
        return;
      }
      let msg = '📝 *Dev.to Top Articles*\n\n';
      articles.slice(0, 10).forEach((a, i) => {
        msg += `${i + 1}. *${a.title}*\n   by ${a.author} | ❤️ ${a.reactions} | 💬 ${a.comments} | ${a.readingTime}min\n   Tags: ${a.tags.join(', ') || 'none'}\n\n`;
      });
      await sendLongMessage(ctx, msg, 'Markdown');
    } catch (err) {
      console.error('[Bot] Dev.to fetch error:', err);
      await ctx.reply(await explainError(err, 'fetching Dev.to articles'));
    }
  });

  bot.command('prefs', async (ctx) => {
    const prefs = loadPreferences();
    const msg = `⚙️ *Your Preferences*\n\n` +
      `*Interests:* ${prefs.interests.join(', ')}\n` +
      `*Languages:* ${prefs.languages.join(', ')}\n` +
      `*Avoid:* ${prefs.avoidTopics.length ? prefs.avoidTopics.join(', ') : 'nothing'}\n` +
      `*Idea Style:* ${prefs.ideaStyle}\n` +
      `*Model:* ${prefs.model}\n` +
      `*Report Time:* ${prefs.dailyReportTime} (${prefs.timezone})\n\n` +
      `*Source Limits:*\n` +
      `  GitHub: ${prefs.maxGitHubRepos} | HN: ${prefs.maxHNStories}\n` +
      `  Reddit: ${prefs.maxRedditPosts} | PH: ${prefs.maxPHProducts} | Dev.to: ${prefs.maxDevToArticles}`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.command('setinterests', async (ctx) => {
    const text = ctx.message.text.replace('/setinterests', '').trim();
    if (!text) {
      await ctx.reply('Usage: /setinterests AI, web dev, machine learning, ...');
      return;
    }
    const interests = text.split(',').map(s => s.trim()).filter(Boolean);
    updatePreferences({ interests });
    await ctx.reply(`✅ Interests updated: ${interests.join(', ')}`);
  });

  bot.command('setlangs', async (ctx) => {
    const text = ctx.message.text.replace('/setlangs', '').trim();
    if (!text) {
      await ctx.reply('Usage: /setlangs JavaScript, Python, Rust, ...');
      return;
    }
    const languages = text.split(',').map(s => s.trim()).filter(Boolean);
    updatePreferences({ languages });
    await ctx.reply(`✅ Languages updated: ${languages.join(', ')}`);
  });

  bot.command('setmodel', async (ctx) => {
    const text = ctx.message.text.replace('/setmodel', '').trim();
    if (!text) {
      const models = getAllModels();
      const available = getAvailableModels();
      let msg = '🤖 *Available models:*\n\n';
      models.forEach(m => {
        const status = available.includes(m) ? '✅' : '🔒 (no API key)';
        msg += `• \`${m}\` ${status}\n`;
      });
      msg += '\nUsage: /setmodel <model-name>';
      await ctx.reply(msg, { parse_mode: 'Markdown' });
      return;
    }
    const all = getAllModels();
    if (!all.includes(text)) {
      await ctx.reply(`❌ Unknown model: ${text}\nUse /models to see available options.`);
      return;
    }
    updatePreferences({ model: text });
    await ctx.reply(`✅ Model set to: ${text}`);
  });

  bot.command('models', async (ctx) => {
    const all = getAllModels();
    const available = getAvailableModels();
    const prefs = loadPreferences();
    let msg = '🤖 *Supported Models*\n\n';
    const groups = {
      'OpenAI': all.filter(m => m.startsWith('gpt')),
      'Anthropic': all.filter(m => m.startsWith('claude')),
      'Google': all.filter(m => m.startsWith('gemini')),
      'Together (Llama)': all.filter(m => m.startsWith('llama')),
      'MiniMax': all.filter(m => m.startsWith('minimax')),
    };
    for (const [group, models] of Object.entries(groups)) {
      msg += `*${group}:*\n`;
      models.forEach(m => {
        const active = m === prefs.model ? ' ← current' : '';
        const status = available.includes(m) ? '✅' : '🔒';
        msg += `  ${status} \`${m}\`${active}\n`;
      });
      msg += '\n';
    }
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.command('idea', async (ctx) => {
    const topic = ctx.message.text.replace('/idea', '').trim() || 'something trending today';
    const prefs = loadPreferences();
    const available = getAvailableModels();
    const model = available.includes(prefs.model) ? prefs.model : available[0];
    if (!model) {
      await ctx.reply('❌ No LLM model available. Set an API key first.');
      return;
    }
    await ctx.reply('💡 Thinking of an idea...');
    try {
      const response = await chat(model, [
        { role: 'system', content: `You are TrendForge, a creative tech project idea generator. The user likes: ${prefs.interests.join(', ')}. They code in: ${prefs.languages.join(', ')}. Their preferred style: ${prefs.ideaStyle}.` },
        { role: 'user', content: `Generate a detailed, practical project idea about: ${topic}. Include: project name, what it does, tech stack, key features (3-5), and estimated build time.` },
      ]);
      await sendLongMessage(ctx, `💡 *Project Idea*\n\n${response}`);
    } catch (err) {
      console.error('[Bot] Idea generation failed:', err);
      await ctx.reply(await explainError(err, 'generating a project idea'));
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;

    const prefs = loadPreferences();
    const available = getAvailableModels();
    const allModels = getAllModels();
    const model = available.includes(prefs.model) ? prefs.model : available[0];
    if (!model) {
      await ctx.reply('❌ No LLM available. Configure at least one API key in .env to chat.');
      return;
    }

    const chatId = ctx.chat.id;
    addToHistory(chatId, 'user', text);
    const history = getHistory(chatId);

    const settingsPrompt = `You are TrendForge, a helpful tech trend assistant. You help users discover trending repos, discuss tech news, brainstorm project ideas, and analyze tech trends. You monitor 5 sources: GitHub Trending, Hacker News, Reddit, Product Hunt, and Dev.to. Be concise, insightful, and friendly.

CURRENT USER SETTINGS:
- Interests: ${JSON.stringify(prefs.interests)}
- Languages: ${JSON.stringify(prefs.languages)}
- Avoid topics: ${JSON.stringify(prefs.avoidTopics)}
- Idea style: "${prefs.ideaStyle}"
- Model: "${prefs.model}"
- Max GitHub repos: ${prefs.maxGitHubRepos}
- Max HN stories: ${prefs.maxHNStories}
- Max Reddit posts: ${prefs.maxRedditPosts}
- Max PH products: ${prefs.maxPHProducts}
- Max Dev.to articles: ${prefs.maxDevToArticles}

SETTINGS MANAGEMENT:
When the user wants to change their preferences/settings through natural language, you MUST include a JSON block in your response wrapped in [SETTINGS_UPDATE] tags. Only include the fields that are changing.

Available settings fields:
- interests: array of strings
- languages: array of strings
- avoidTopics: array of strings
- ideaStyle: string (e.g. "practical", "ambitious", "experimental")
- model: string (must be one of: ${allModels.join(', ')})
- maxGitHubRepos: number (1-25)
- maxHNStories: number (1-30)
- maxRedditPosts: number (1-30)
- maxPHProducts: number (1-10)
- maxDevToArticles: number (1-15)

RULES for settings updates:
- "add X to my interests/languages" → include existing items PLUS the new one
- "remove X from my interests" → include existing items MINUS that one
- "set my interests to X, Y, Z" → replace entirely with new list
- "switch to model X" or "use X" → set model field (match to closest valid model name)
- "show me more GitHub repos" → increase maxGitHubRepos
- "I don't want to see blockchain stuff" → add to avoidTopics
- Always respond conversationally AND include the tag block

Example response when user says "add Rust to my languages and switch to gpt-4o":
Sure! I've added Rust to your languages and switched your model to gpt-4o. Your reports will now include Rust-specific trending repos too! 🦀
[SETTINGS_UPDATE]{"languages":["JavaScript","TypeScript","Python","Rust"],"model":"gpt-4o"}[/SETTINGS_UPDATE]

If the message is NOT about changing settings, just respond normally without any tags.`;

    try {
      const response = await chat(model, [
        { role: 'system', content: settingsPrompt },
        ...history,
      ]);

      const { cleanResponse, settingsUpdate } = parseSettingsUpdate(response);

      if (settingsUpdate) {
        try {
          const updated = updatePreferences(settingsUpdate);
          console.log('[Bot] Settings updated via natural language:', JSON.stringify(settingsUpdate));
          const confirmParts = [];
          if (settingsUpdate.interests) confirmParts.push(`Interests: ${updated.interests.join(', ')}`);
          if (settingsUpdate.languages) confirmParts.push(`Languages: ${updated.languages.join(', ')}`);
          if (settingsUpdate.avoidTopics) confirmParts.push(`Avoid: ${updated.avoidTopics.join(', ') || 'nothing'}`);
          if (settingsUpdate.ideaStyle) confirmParts.push(`Idea style: ${updated.ideaStyle}`);
          if (settingsUpdate.model) confirmParts.push(`Model: ${updated.model}`);
          if (settingsUpdate.maxGitHubRepos) confirmParts.push(`GitHub repos: ${updated.maxGitHubRepos}`);
          if (settingsUpdate.maxHNStories) confirmParts.push(`HN stories: ${updated.maxHNStories}`);
          if (settingsUpdate.maxRedditPosts) confirmParts.push(`Reddit posts: ${updated.maxRedditPosts}`);
          if (settingsUpdate.maxPHProducts) confirmParts.push(`PH products: ${updated.maxPHProducts}`);
          if (settingsUpdate.maxDevToArticles) confirmParts.push(`Dev.to articles: ${updated.maxDevToArticles}`);

          const confirm = confirmParts.length > 0
            ? `\n\n⚙️ *Settings saved:*\n${confirmParts.map(p => `  • ${p}`).join('\n')}`
            : '';

          addToHistory(chatId, 'assistant', cleanResponse);
          await sendLongMessage(ctx, cleanResponse + confirm);
        } catch (parseErr) {
          console.error('[Bot] Failed to apply settings:', parseErr.message);
          addToHistory(chatId, 'assistant', cleanResponse);
          await sendLongMessage(ctx, cleanResponse);
        }
      } else {
        addToHistory(chatId, 'assistant', cleanResponse);
        await sendLongMessage(ctx, cleanResponse);
      }
    } catch (err) {
      console.error('[Bot] Chat error:', err.message);
      await ctx.reply('❌ Sorry, I encountered an error. Try again or check /models.');
    }
  });

  return bot;
}

async function sendLongMessage(ctx, text, parseMode) {
  const maxLen = 4000;
  if (text.length <= maxLen) {
    try {
      await ctx.reply(text, parseMode ? { parse_mode: parseMode } : {});
    } catch {
      await ctx.reply(stripMarkdown(text));
    }
    return;
  }
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt);
  }
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, parseMode ? { parse_mode: parseMode } : {});
    } catch {
      await ctx.reply(stripMarkdown(chunk));
    }
  }
}

function stripMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '');
}

function parseSettingsUpdate(response) {
  const match = response.match(/\[SETTINGS_UPDATE\]([\s\S]*?)\[\/SETTINGS_UPDATE\]/);
  if (!match) return { cleanResponse: response, settingsUpdate: null };

  const cleanResponse = response
    .replace(/\[SETTINGS_UPDATE\][\s\S]*?\[\/SETTINGS_UPDATE\]/, '')
    .trim();

  try {
    const parsed = JSON.parse(match[1].trim());
    const allowed = new Set([
      'interests', 'languages', 'avoidTopics', 'ideaStyle', 'model',
      'maxGitHubRepos', 'maxHNStories', 'maxRedditPosts', 'maxPHProducts', 'maxDevToArticles',
    ]);
    const settingsUpdate = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (allowed.has(key)) settingsUpdate[key] = value;
    }
    return { cleanResponse, settingsUpdate: Object.keys(settingsUpdate).length > 0 ? settingsUpdate : null };
  } catch {
    console.warn('[Bot] Failed to parse settings JSON from LLM response');
    return { cleanResponse, settingsUpdate: null };
  }
}

module.exports = { createBot };
