const { fetchGitHubTrendingByPrefs } = require('./scrapers/github');
const { fetchTopStories } = require('./scrapers/hackernews');
const { fetchRedditHot } = require('./scrapers/reddit');
const { fetchProductHunt } = require('./scrapers/producthunt');
const { fetchDevToByInterests } = require('./scrapers/devto');
const { chat, getAvailableModels } = require('./llm/providers');
const { loadPreferences } = require('./preferences');
const { withRetry } = require('./utils/retry');

async function generateDailyReport() {
  const prefs = loadPreferences();

  const [githubRepos, hnStories, redditPosts, phProducts, devtoArticles] = await Promise.all([
    withRetry(() => fetchGitHubTrendingByPrefs(prefs.languages), { label: 'GitHub' }).catch(err => {
      console.error('[Report] GitHub scrape failed:', err.message);
      return [];
    }),
    withRetry(() => fetchTopStories(), { label: 'HackerNews' }).catch(err => {
      console.error('[Report] HN fetch failed:', err.message);
      return [];
    }),
    withRetry(() => fetchRedditHot(), { label: 'Reddit' }).catch(err => {
      console.error('[Report] Reddit fetch failed:', err.message);
      return [];
    }),
    withRetry(() => fetchProductHunt(), { label: 'ProductHunt' }).catch(err => {
      console.error('[Report] Product Hunt fetch failed:', err.message);
      return [];
    }),
    withRetry(() => fetchDevToByInterests(prefs.interests), { label: 'DevTo' }).catch(err => {
      console.error('[Report] Dev.to fetch failed:', err.message);
      return [];
    }),
  ]);

  const totalSources = [githubRepos, hnStories, redditPosts, phProducts, devtoArticles]
    .filter(arr => arr.length > 0).length;

  if (totalSources === 0) {
    return '⚠️ Could not fetch data from any source. Will retry next cycle.';
  }

  const model = prefs.model;
  const available = getAvailableModels();
  const activeModel = available.includes(model) ? model : available[0];

  if (!activeModel) {
    return formatRawReport(githubRepos, hnStories, redditPosts, phProducts, devtoArticles, prefs);
  }

  if (activeModel !== model) {
    console.log(`[Report] Model ${model} not available, falling back to ${activeModel}`);
  }

  const ghSummary = githubRepos.slice(0, prefs.maxGitHubRepos).map((r, i) =>
    `${i + 1}. ${r.name} (${r.language}, ⭐ ${r.totalStars}) - ${r.description}`
  ).join('\n');

  const hnSummary = hnStories.slice(0, prefs.maxHNStories).map((s, i) =>
    `${i + 1}. "${s.title}" (${s.score} pts, ${s.comments} comments) - ${s.url}`
  ).join('\n');

  const redditSummary = redditPosts.slice(0, prefs.maxRedditPosts || 10).map((p, i) =>
    `${i + 1}. [r/${p.subreddit}] "${p.title}" (${p.score} upvotes, ${p.comments} comments)`
  ).join('\n');

  const phSummary = phProducts.slice(0, prefs.maxPHProducts || 5).map((p, i) =>
    `${i + 1}. ${p.name} - ${p.tagline} (${p.votes} upvotes)`
  ).join('\n');

  const devtoSummary = devtoArticles.slice(0, prefs.maxDevToArticles || 5).map((a, i) =>
    `${i + 1}. "${a.title}" by ${a.author} (${a.reactions} reactions, ${a.readingTime}min read) [${a.tags.join(', ')}]`
  ).join('\n');

  const prompt = `You are TrendForge, a daily tech trend analyst. Based on the user's interests and today's trending data from 5 sources, create a concise daily briefing.

USER PROFILE:
- Interests: ${prefs.interests.join(', ')}
- Preferred languages: ${prefs.languages.join(', ')}
- Avoid topics: ${prefs.avoidTopics.length ? prefs.avoidTopics.join(', ') : 'none'}
- Idea style: ${prefs.ideaStyle}

TODAY'S GITHUB TRENDING:
${ghSummary || 'No data available'}

TODAY'S HACKER NEWS TOP STORIES:
${hnSummary || 'No data available'}

TODAY'S REDDIT HOT POSTS (programming communities):
${redditSummary || 'No data available'}

TODAY'S PRODUCT HUNT:
${phSummary || 'No data available'}

TODAY'S DEV.TO TOP ARTICLES:
${devtoSummary || 'No data available'}

Generate a report with these sections:
1. 🔥 TOP PICKS (5-7 most relevant items across ALL sources matching user interests, with brief why-it-matters)
2. 💡 PROJECT IDEAS (3-4 practical project ideas inspired by today's trends, tailored to user's interests and preferred languages)
3. 📊 TREND SIGNALS (3-4 sentence summary of what's hot today in tech, drawing from all 5 sources)
4. 🚀 PRODUCT SPOTLIGHT (1-2 interesting Product Hunt launches worth watching)

Keep it concise, actionable, and under 3000 characters. Use Telegram-friendly markdown formatting.`;

  try {
    const response = await chat(activeModel, [
      { role: 'system', content: 'You are TrendForge, a helpful daily tech trend analyst. Be concise, insightful, and actionable.' },
      { role: 'user', content: prompt },
    ]);
    const sourcesUsed = [
      githubRepos.length > 0 && 'GitHub',
      hnStories.length > 0 && 'HN',
      redditPosts.length > 0 && 'Reddit',
      phProducts.length > 0 && 'PH',
      devtoArticles.length > 0 && 'Dev.to',
    ].filter(Boolean).join(' · ');
    return `🔨 *TrendForge Daily Report*\n_Powered by ${activeModel} | Sources: ${sourcesUsed}_\n\n${response}`;
  } catch (err) {
    console.error('[Report] LLM call failed:', err.message);
    return formatRawReport(githubRepos, hnStories, redditPosts, phProducts, devtoArticles, prefs);
  }
}

function formatRawReport(repos, stories, redditPosts, phProducts, devtoArticles, prefs) {
  let report = '🔨 *TrendForge Daily Report*\n_(LLM unavailable — raw data)_\n\n';

  if (repos.length > 0) {
    report += '📦 *GitHub Trending*\n';
    repos.slice(0, prefs.maxGitHubRepos).forEach((r, i) => {
      report += `${i + 1}. ${r.name} (${r.language})\n   ${r.description}\n`;
    });
    report += '\n';
  }

  if (stories.length > 0) {
    report += '📰 *Hacker News Top*\n';
    stories.slice(0, prefs.maxHNStories).forEach((s, i) => {
      report += `${i + 1}. ${s.title} (${s.score} pts)\n`;
    });
    report += '\n';
  }

  if (redditPosts.length > 0) {
    report += '🤖 *Reddit Hot*\n';
    redditPosts.slice(0, prefs.maxRedditPosts || 10).forEach((p, i) => {
      report += `${i + 1}. [r/${p.subreddit}] ${p.title} (${p.score}↑)\n`;
    });
    report += '\n';
  }

  if (phProducts.length > 0) {
    report += '🚀 *Product Hunt*\n';
    phProducts.slice(0, prefs.maxPHProducts || 5).forEach((p, i) => {
      report += `${i + 1}. ${p.name} — ${p.tagline}\n`;
    });
    report += '\n';
  }

  if (devtoArticles.length > 0) {
    report += '📝 *Dev.to Top*\n';
    devtoArticles.slice(0, prefs.maxDevToArticles || 5).forEach((a, i) => {
      report += `${i + 1}. ${a.title} (${a.reactions}❤️)\n`;
    });
  }

  return report;
}

module.exports = { generateDailyReport };
