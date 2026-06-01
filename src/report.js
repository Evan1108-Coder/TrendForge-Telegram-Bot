const { fetchGitHubTrending } = require('./scrapers/github');
const { fetchTopStories } = require('./scrapers/hackernews');
const { chat, getAvailableModels } = require('./llm/providers');
const { loadPreferences } = require('./preferences');

async function generateDailyReport() {
  const prefs = loadPreferences();

  const [githubRepos, hnStories] = await Promise.all([
    fetchGitHubTrending().catch(err => {
      console.error('GitHub scrape failed:', err.message);
      return [];
    }),
    fetchTopStories().catch(err => {
      console.error('HN fetch failed:', err.message);
      return [];
    }),
  ]);

  if (githubRepos.length === 0 && hnStories.length === 0) {
    return '⚠️ Could not fetch data from GitHub Trending or Hacker News. Will retry next cycle.';
  }

  const model = prefs.model;
  const available = getAvailableModels();
  if (!available.includes(model)) {
    const fallback = available[0];
    if (!fallback) {
      return formatRawReport(githubRepos, hnStories, prefs);
    }
    console.log(`Model ${model} not available, falling back to ${fallback}`);
  }

  const activeModel = available.includes(model) ? model : available[0];
  if (!activeModel) {
    return formatRawReport(githubRepos, hnStories, prefs);
  }

  const ghSummary = githubRepos.slice(0, prefs.maxGitHubRepos).map((r, i) =>
    `${i + 1}. ${r.name} (${r.language}, ⭐ ${r.totalStars}) - ${r.description}`
  ).join('\n');

  const hnSummary = hnStories.slice(0, prefs.maxHNStories).map((s, i) =>
    `${i + 1}. "${s.title}" (${s.score} pts, ${s.comments} comments) - ${s.url}`
  ).join('\n');

  const prompt = `You are TrendForge, a daily tech trend analyst. Based on the user's interests and today's trending data, create a concise daily briefing.

USER PROFILE:
- Interests: ${prefs.interests.join(', ')}
- Preferred languages: ${prefs.languages.join(', ')}
- Avoid topics: ${prefs.avoidTopics.length ? prefs.avoidTopics.join(', ') : 'none'}
- Idea style: ${prefs.ideaStyle}

TODAY'S GITHUB TRENDING:
${ghSummary || 'No data available'}

TODAY'S HACKER NEWS TOP STORIES:
${hnSummary || 'No data available'}

Generate a report with these sections:
1. 🔥 TOP PICKS (3-5 most relevant repos/stories matching user interests, with brief why-it-matters)
2. 💡 PROJECT IDEAS (2-3 practical project ideas inspired by today's trends, tailored to user's interests and preferred languages)
3. 📊 TREND SIGNALS (2-3 sentence summary of what's hot today in tech)

Keep it concise, actionable, and under 2000 characters. Use Telegram-friendly markdown formatting.`;

  try {
    const response = await chat(activeModel, [
      { role: 'system', content: 'You are TrendForge, a helpful daily tech trend analyst. Be concise, insightful, and actionable.' },
      { role: 'user', content: prompt },
    ]);
    return `🔨 *TrendForge Daily Report*\n_Powered by ${activeModel}_\n\n${response}`;
  } catch (err) {
    console.error('LLM call failed:', err.message);
    return formatRawReport(githubRepos, hnStories, prefs);
  }
}

function formatRawReport(repos, stories, prefs) {
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
  }

  return report;
}

module.exports = { generateDailyReport };
