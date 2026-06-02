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

  const prompt = `You are TrendForge, a daily tech trend analyst. Based on the user's interests and today's trending data from 5 sources, create a detailed daily briefing.

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
1. 🔥 <b>TOP PICKS</b> (5-7 most relevant items across ALL sources matching user interests) — For each pick, write 2-3 sentences explaining what the project/story is about, why it's significant, and why the user should care based on their interests. Include the source (GitHub/HN/Reddit/PH/Dev.to).
2. 💡 <b>PROJECT IDEAS</b> (3-4 practical project ideas inspired by today's trends) — For each idea, describe the concept in detail: what it does, the suggested tech stack, 3-4 key features, and who would use it. Tailor to user's preferred languages and interests.
3. 📊 <b>TREND SIGNALS</b> (5-6 sentences analyzing what's hot today in tech, drawing connections between items from different sources, identifying emerging patterns)
4. 🚀 <b>PRODUCT SPOTLIGHT</b> (2-3 interesting Product Hunt launches worth watching) — Describe what each product does, the problem it solves, and what makes it stand out.

FORMATTING RULES (CRITICAL):
- Use Telegram HTML formatting ONLY: <b>bold</b>, <i>italic</i>, <code>code</code>, <a href="url">link</a>
- NEVER use Markdown: no *, no **, no _, no __, no \`, no #, no []()
- Use <b>bold</b> for section headers, project names, and key terms
- Use <i>italic</i> for sources and secondary info
- Separate items with blank lines for readability
- Aim for 4000-5000 characters. Be detailed and informative — don't sacrifice quality for brevity.`;

  try {
    const response = await chat(activeModel, [
      { role: 'system', content: 'You are TrendForge, a helpful daily tech trend analyst. Be detailed, insightful, and actionable. Always use Telegram HTML formatting (<b>, <i>, <code>) — NEVER use Markdown (*, **, _, #).' },
      { role: 'user', content: prompt },
    ]);
    const sourcesUsed = [
      githubRepos.length > 0 && 'GitHub',
      hnStories.length > 0 && 'HN',
      redditPosts.length > 0 && 'Reddit',
      phProducts.length > 0 && 'PH',
      devtoArticles.length > 0 && 'Dev.to',
    ].filter(Boolean).join(' · ');
    return `🔨 <b>TrendForge Daily Report</b>\n<i>Powered by ${activeModel} | Sources: ${sourcesUsed}</i>\n\n${response}`;
  } catch (err) {
    console.error('[Report] LLM call failed:', err.message);
    return formatRawReport(githubRepos, hnStories, redditPosts, phProducts, devtoArticles, prefs);
  }
}

function formatRawReport(repos, stories, redditPosts, phProducts, devtoArticles, prefs) {
  let report = '🔨 <b>TrendForge Daily Report</b>\n<i>(LLM unavailable — raw data)</i>\n\n';

  if (repos.length > 0) {
    report += '📦 <b>GitHub Trending</b>\n';
    repos.slice(0, prefs.maxGitHubRepos).forEach((r, i) => {
      report += `${i + 1}. <b>${escapeHtml(r.name)}</b> (${escapeHtml(r.language)})\n   ${escapeHtml(r.description)}\n`;
    });
    report += '\n';
  }

  if (stories.length > 0) {
    report += '📰 <b>Hacker News Top</b>\n';
    stories.slice(0, prefs.maxHNStories).forEach((s, i) => {
      report += `${i + 1}. ${escapeHtml(s.title)} (${s.score} pts)\n`;
    });
    report += '\n';
  }

  if (redditPosts.length > 0) {
    report += '🤖 <b>Reddit Hot</b>\n';
    redditPosts.slice(0, prefs.maxRedditPosts || 10).forEach((p, i) => {
      report += `${i + 1}. <i>r/${escapeHtml(p.subreddit)}</i> ${escapeHtml(p.title)} (${p.score}↑)\n`;
    });
    report += '\n';
  }

  if (phProducts.length > 0) {
    report += '🚀 <b>Product Hunt</b>\n';
    phProducts.slice(0, prefs.maxPHProducts || 5).forEach((p, i) => {
      report += `${i + 1}. <b>${escapeHtml(p.name)}</b> — ${escapeHtml(p.tagline)}\n`;
    });
    report += '\n';
  }

  if (devtoArticles.length > 0) {
    report += '📝 <b>Dev.to Top</b>\n';
    devtoArticles.slice(0, prefs.maxDevToArticles || 5).forEach((a, i) => {
      report += `${i + 1}. ${escapeHtml(a.title)} (${a.reactions}❤️)\n`;
    });
  }

  return report;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { generateDailyReport };
