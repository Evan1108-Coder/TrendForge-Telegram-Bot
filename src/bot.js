const { Bot } = require('grammy');
const { chat, getAllModels, getAvailableModels } = require('./llm/providers');
const { loadPreferences, updatePreferences } = require('./preferences');
const { restartCron, scheduleLabel } = require('./cron');
const { fetchGitHubTrendingByPrefs } = require('./scrapers/github');
const { fetchTopStories } = require('./scrapers/hackernews');
const { fetchRedditHot } = require('./scrapers/reddit');
const { fetchProductHunt } = require('./scrapers/producthunt');
const { fetchDevToByInterests } = require('./scrapers/devto');
const { withRetry } = require('./utils/retry');
const { cleanOutput, sendLong } = require('./utils/format');

function createBot(token) {
  const bot = new Bot(token);
  const conversationHistory = new Map();
  const messageQueue = new Map();
  const processing = new Set();

  function getHistory(chatId) {
    if (!conversationHistory.has(chatId)) conversationHistory.set(chatId, []);
    return conversationHistory.get(chatId);
  }

  function addToHistory(chatId, role, content) {
    const history = getHistory(chatId);
    history.push({ role, content });
    if (history.length > 30) history.splice(0, history.length - 30);
  }

  bot.command('start', async (ctx) => {
    console.log(`[Bot] /start from ${ctx.from.first_name} (${ctx.from.id}), chat ${ctx.chat.id}`);
    await ctx.reply(
      '🔨 Welcome to TrendForge!\n\n' +
      'I\'m your AI-powered tech trend assistant. I monitor GitHub, Hacker News, Reddit, Product Hunt, and Dev.to to keep you informed about what\'s happening in tech.\n\n' +
      'Just talk to me naturally! For example:\n' +
      '- "What\'s trending on GitHub?"\n' +
      '- "Give me today\'s full report"\n' +
      '- "Any interesting AI projects lately?"\n' +
      '- "Generate a project idea about web scraping"\n' +
      '- "Change my report schedule to every Monday at 9am"\n' +
      '- "Show me my current settings"\n' +
      '- "What\'s hot on Hacker News and Reddit?"\n\n' +
      'I can fetch live data, analyze trends, brainstorm ideas, and manage your settings. Just tell me what you need!'
    );
  });

  bot.on('message:text', (ctx) => {
    const text = ctx.message.text;
    if (text === '/start') return;

    const chatId = ctx.chat.id;

    if (processing.has(chatId)) {
      if (!messageQueue.has(chatId)) messageQueue.set(chatId, { messages: [], ctx });
      const queue = messageQueue.get(chatId);
      queue.messages.push(text);
      queue.ctx = ctx;
      return;
    }

    processing.add(chatId);
    (async () => {
      try {
        await processMessages(ctx, chatId, [text]);

        while (messageQueue.has(chatId) && messageQueue.get(chatId).messages.length > 0) {
          const queue = messageQueue.get(chatId);
          const msgs = queue.messages.splice(0);
          await processMessages(queue.ctx, chatId, msgs);
        }
      } catch (err) {
        console.error('[Bot] Unhandled processing error:', err.message);
      } finally {
        processing.delete(chatId);
        messageQueue.delete(chatId);
      }
    })();
  });

  async function processMessages(ctx, chatId, messages) {
    const combinedText = messages.length === 1 ? messages[0] : messages.join('\n');
    addToHistory(chatId, 'user', combinedText);

    const prefs = loadPreferences();
    const available = getAvailableModels();
    const allModels = getAllModels();
    const model = available.includes(prefs.model) ? prefs.model : available[0];

    if (!model) {
      await ctx.reply('No AI model available right now. Please check API key configuration.');
      return;
    }

    const history = getHistory(chatId);
    const systemPrompt = buildSystemPrompt(prefs, allModels);

    try {
      const phase1Response = await chat(model, [
        { role: 'system', content: systemPrompt },
        ...history,
      ]);

      const parsed = parseResponse(phase1Response);

      if (parsed.settingsUpdate) {
        applySettings(parsed.settingsUpdate);
      }

      if (parsed.dataSources.length > 0) {
        const ack = cleanOutput(parsed.cleanText) || 'Let me fetch that data for you...';
        await ctx.reply(ack);

        const data = await fetchSources(parsed.dataSources, prefs);
        const dataText = formatDataForAI(data);

        const phase2Response = await chat(model, [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'assistant', content: ack },
          { role: 'user', content: `[Here is the live data you requested]\n\n${dataText}\n\nNow provide your detailed analysis and response based on this data. Remember: plain text only, no markdown, no HTML. Be detailed and insightful.` },
        ]);

        const cleaned = cleanOutput(phase2Response) || 'Here\'s what I found — but I had trouble formatting it. Try asking again!';
        addToHistory(chatId, 'assistant', cleaned);
        await sendLong(ctx, cleaned);
      } else {
        let cleaned = cleanOutput(parsed.cleanText);
        if (!cleaned && parsed.settingsUpdate) {
          const parts = [];
          const su = parsed.settingsUpdate;
          if (su.interests) parts.push(`Interests: ${su.interests.join(', ')}`);
          if (su.languages) parts.push(`Languages: ${su.languages.join(', ')}`);
          if (su.avoidTopics) parts.push(`Avoid: ${su.avoidTopics.join(', ')}`);
          if (su.ideaStyle) parts.push(`Idea style: ${su.ideaStyle}`);
          if (su.model) parts.push(`Model: ${su.model}`);
          if ('reportEnabled' in su) parts.push(`Reports: ${su.reportEnabled ? 'enabled' : 'disabled'}`);
          if (su.reportScheduleText) parts.push(`Schedule: ${su.reportScheduleText}`);
          if (su.timezone) parts.push(`Timezone: ${su.timezone}`);
          cleaned = 'Done! Your settings have been updated:\n' + parts.map(p => `- ${p}`).join('\n');
        }
        if (!cleaned) cleaned = 'I\'m not sure how to respond to that. Try asking about tech trends, project ideas, or say "show me my settings"!';
        addToHistory(chatId, 'assistant', cleaned);
        await sendLong(ctx, cleaned);
      }
    } catch (err) {
      console.error('[Bot] Error:', err.message);
      await ctx.reply('Something went wrong processing your request. Please try again or rephrase your question.');
    }
  }

  function applySettings(settingsUpdate) {
    try {
      updatePreferences(settingsUpdate);
      console.log('[Bot] Settings updated:', JSON.stringify(settingsUpdate));
      const scheduleFields = ['reportEnabled', 'reportCron', 'reportScheduleText', 'dailyReportTime', 'timezone'];
      if (scheduleFields.some(f => f in settingsUpdate)) {
        restartCron();
        console.log('[Bot] Cron restarted after schedule change');
      }
    } catch (e) {
      console.error('[Bot] Settings update failed:', e.message);
    }
  }

  function buildSystemPrompt(prefs, allModels) {
    const schedule = scheduleLabel(prefs);
    return `You are TrendForge, an intelligent tech trend assistant running as a Telegram bot. You help users explore tech trends, discover projects, brainstorm ideas, manage preferences, and have conversations about technology.

YOUR CAPABILITIES:
You have access to real-time data from 5 sources:
- GitHub Trending (github): Trending repositories across programming languages
- Hacker News (hn): Top stories and discussions from the tech community
- Reddit (reddit): Hot posts from programming communities (r/programming, r/webdev, r/MachineLearning, etc.)
- Product Hunt (ph): Latest product launches and tools
- Dev.to (devto): Top developer articles and tutorials

You can:
- Fetch and analyze data from any combination of these sources
- Generate comprehensive trend reports combining all sources
- Brainstorm project ideas based on current trends and user interests
- Update user preferences (interests, languages, schedule, model, limits, etc.)
- Discuss tech topics, programming, industry trends, and more
- Show the user their current configuration and settings

CURRENT USER SETTINGS:
- Interests: ${prefs.interests.join(', ')}
- Languages: ${prefs.languages.join(', ')}
- Avoid topics: ${prefs.avoidTopics.length ? prefs.avoidTopics.join(', ') : 'none'}
- Idea style: ${prefs.ideaStyle}
- AI Model: ${prefs.model}
- Report schedule: ${schedule}
- Report enabled: ${prefs.reportEnabled !== false}
- Timezone: ${prefs.timezone}
- Source limits: GitHub ${prefs.maxGitHubRepos}, HN ${prefs.maxHNStories}, Reddit ${prefs.maxRedditPosts}, PH ${prefs.maxPHProducts}, Dev.to ${prefs.maxDevToArticles}

REQUESTING DATA:
If you need live data from any source to answer the user, include this tag at the very end of your message:
[NEED_DATA:source1,source2,...]

Available source names: github, hn, reddit, ph, devto
Use "all" to request all 5 sources at once (for full reports).

IMPORTANT: You MUST ALWAYS write a conversational message BEFORE any tags. Never respond with only tags and no text. The text before the tag is what the user sees.

When you include [NEED_DATA], write a brief natural acknowledgment BEFORE the tag, like "Let me check GitHub trending for you!" or "Pulling up the latest Hacker News stories..." — this message will be shown to the user while data loads.

Only request data when you actually need current/live information. For general conversation, settings questions, idea brainstorming from memory, or simple questions, respond directly without [NEED_DATA].

Examples:
- "What's trending on GitHub?" -> acknowledge + [NEED_DATA:github]
- "Show me HN and Reddit" -> acknowledge + [NEED_DATA:hn,reddit]
- "Give me a full report" -> acknowledge + [NEED_DATA:all]
- "What are my settings?" -> respond directly, no data needed
- "Change my interests" -> respond directly with settings update
- "Tell me about React" -> respond directly from knowledge

UPDATING SETTINGS:
When the user wants to change preferences, FIRST write a friendly confirmation message, THEN include the tag at the end:
[SETTINGS_UPDATE]{"field":"value",...}[/SETTINGS_UPDATE]

Example: "Done! I've updated your interests to AI, robotics, and blockchain." followed by the tag.

Available fields:
- interests: array of strings
- languages: array of strings
- avoidTopics: array of strings
- ideaStyle: string ("practical", "ambitious", "experimental")
- model: string (one of: ${allModels.join(', ')})
- reportEnabled: boolean
- reportCron: string (5-field cron: minute hour dayOfMonth month dayOfWeek)
- reportScheduleText: string (human description)
- dailyReportTime: string (HH:MM)
- timezone: string (IANA, e.g. "Asia/Hong_Kong")
- maxGitHubRepos: number (1-25)
- maxHNStories: number (1-30)
- maxRedditPosts: number (1-30)
- maxPHProducts: number (1-10)
- maxDevToArticles: number (1-15)

Settings rules:
- "add X to interests" -> include existing items plus the new one
- "remove X" -> include existing items minus that one
- "set interests to X, Y" -> replace entirely
- Schedule changes need reportCron + reportScheduleText + dailyReportTime (if time changes)
- "stop/pause reports" -> reportEnabled: false
- "resume/restart reports" -> reportEnabled: true

RESPONSE FORMAT (CRITICAL):
- Write CLEAN PLAIN TEXT only
- NEVER use Markdown formatting: no *, **, _, \`, #, []()
- NEVER use HTML tags: no <b>, <i>, <code>, etc.
- Use emoji for visual structure (section headers, bullet markers)
- Use numbered lists (1. 2. 3.) and dashes (- item) for structure
- Use ALL CAPS sparingly for emphasis on key terms
- Use line breaks and spacing for readability
- Be conversational, detailed, and insightful
- When presenting data, analyze and synthesize it — don't just list items
- Draw connections between trends across different sources
- Provide actionable insights and your perspective`;
  }

  function parseResponse(text) {
    let cleanText = text;
    let dataSources = [];
    let settingsUpdate = null;

    const dataMatch = cleanText.match(/\[NEED_DATA:([^\]]+)\]/);
    if (dataMatch) {
      const sources = dataMatch[1].toLowerCase().split(',').map(s => s.trim());
      if (sources.includes('all')) {
        dataSources = ['github', 'hn', 'reddit', 'ph', 'devto'];
      } else {
        dataSources = sources.filter(s => ['github', 'hn', 'reddit', 'ph', 'devto'].includes(s));
      }
      cleanText = cleanText.replace(/\[NEED_DATA:[^\]]+\]/g, '').trim();
    }

    const settingsMatch = cleanText.match(/\[SETTINGS_UPDATE\]([\s\S]*?)\[\/SETTINGS_UPDATE\]/);
    if (settingsMatch) {
      cleanText = cleanText.replace(/\[SETTINGS_UPDATE\][\s\S]*?\[\/SETTINGS_UPDATE\]/g, '').trim();
      try {
        const parsed = JSON.parse(settingsMatch[1].trim());
        const allowed = new Set([
          'interests', 'languages', 'avoidTopics', 'ideaStyle', 'model',
          'reportEnabled', 'reportCron', 'reportScheduleText', 'dailyReportTime', 'timezone',
          'maxGitHubRepos', 'maxHNStories', 'maxRedditPosts', 'maxPHProducts', 'maxDevToArticles',
        ]);
        const aliases = {
          report_schedule: 'reportScheduleText', report_time: 'dailyReportTime',
          report_cron: 'reportCron', report_enabled: 'reportEnabled',
          avoid_topics: 'avoidTopics', idea_style: 'ideaStyle',
          daily_report_time: 'dailyReportTime', schedule_text: 'reportScheduleText',
          max_github_repos: 'maxGitHubRepos', max_hn_stories: 'maxHNStories',
          max_reddit_posts: 'maxRedditPosts', max_ph_products: 'maxPHProducts',
          max_devto_articles: 'maxDevToArticles',
        };
        settingsUpdate = {};
        for (const [key, value] of Object.entries(parsed)) {
          const normalizedKey = aliases[key] || key;
          if (allowed.has(normalizedKey)) settingsUpdate[normalizedKey] = value;
        }
        if (Object.keys(settingsUpdate).length === 0) settingsUpdate = null;
      } catch {
        console.warn('[Bot] Failed to parse settings JSON from AI response');
      }
    }

    return { cleanText, dataSources, settingsUpdate };
  }

  async function fetchSources(sources, prefs) {
    const results = {};
    const fetchers = {
      github: () => withRetry(() => fetchGitHubTrendingByPrefs(prefs.languages, prefs.maxGitHubRepos), { label: 'GitHub' }),
      hn: () => withRetry(() => fetchTopStories(prefs.maxHNStories), { label: 'HN' }),
      reddit: () => withRetry(() => fetchRedditHot(), { label: 'Reddit' }),
      ph: () => withRetry(() => fetchProductHunt(), { label: 'PH' }),
      devto: () => withRetry(() => fetchDevToByInterests(prefs.interests), { label: 'DevTo' }),
    };

    await Promise.all(sources.map(async (source) => {
      try {
        results[source] = await fetchers[source]();
      } catch (err) {
        console.error(`[Bot] Fetch ${source} failed:`, err.message);
        results[source] = [];
      }
    }));

    return results;
  }

  function formatDataForAI(data) {
    let text = '';

    if (data.github?.length > 0) {
      text += 'GITHUB TRENDING REPOS:\n';
      data.github.forEach((r, i) => {
        text += `${i + 1}. ${r.name} (${r.language}, ${r.totalStars} total stars, ${r.starsToday} today) - ${r.description} | URL: ${r.url}\n`;
      });
      text += '\n';
    }

    if (data.hn?.length > 0) {
      text += 'HACKER NEWS TOP STORIES:\n';
      data.hn.forEach((s, i) => {
        text += `${i + 1}. "${s.title}" (${s.score} pts, ${s.comments} comments, by ${s.by}) - ${s.url}\n`;
      });
      text += '\n';
    }

    if (data.reddit?.length > 0) {
      text += 'REDDIT HOT POSTS:\n';
      data.reddit.forEach((p, i) => {
        text += `${i + 1}. [r/${p.subreddit}] "${p.title}" (${p.score} upvotes, ${p.comments} comments) - ${p.url}\n`;
      });
      text += '\n';
    }

    if (data.ph?.length > 0) {
      text += 'PRODUCT HUNT LAUNCHES:\n';
      data.ph.forEach((p, i) => {
        text += `${i + 1}. ${p.name} - ${p.tagline} (${p.votes} upvotes) - ${p.url}\n`;
      });
      text += '\n';
    }

    if (data.devto?.length > 0) {
      text += 'DEV.TO TOP ARTICLES:\n';
      data.devto.forEach((a, i) => {
        text += `${i + 1}. "${a.title}" by ${a.author} (${a.reactions} reactions, ${a.readingTime}min read) [${a.tags.join(', ')}] - ${a.url}\n`;
      });
      text += '\n';
    }

    const sourceCount = Object.values(data).filter(arr => arr?.length > 0).length;
    if (sourceCount === 0) {
      text = 'No data could be fetched from any of the requested sources at this time.\n';
    }

    return text;
  }

  return bot;
}

module.exports = { createBot };
