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
    const model = available.includes(prefs.model) ? prefs.model : available[0];
    if (!model) {
      await ctx.reply('❌ No LLM available. Configure at least one API key in .env to chat.');
      return;
    }

    const chatId = ctx.chat.id;
    addToHistory(chatId, 'user', text);
    const history = getHistory(chatId);

    try {
      const response = await chat(model, [
        {
          role: 'system',
          content: `You are TrendForge, a helpful tech trend assistant. You help users discover trending repos, discuss tech news, brainstorm project ideas, and analyze tech trends. You monitor 5 sources: GitHub Trending, Hacker News, Reddit, Product Hunt, and Dev.to. Be concise, insightful, and friendly. User interests: ${prefs.interests.join(', ')}. User codes in: ${prefs.languages.join(', ')}.`,
        },
        ...history,
      ]);
      addToHistory(chatId, 'assistant', response);
      await sendLongMessage(ctx, response);
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

module.exports = { createBot };
