const axios = require('axios');

const INTEREST_TAG_MAP = {
  'ai': 'ai',
  'artificial intelligence': 'ai',
  'machine learning': 'machinelearning',
  'ml': 'machinelearning',
  'web development': 'webdev',
  'web dev': 'webdev',
  'frontend': 'frontend',
  'backend': 'backend',
  'open source': 'opensource',
  'devops': 'devops',
  'cloud': 'cloud',
  'security': 'security',
  'mobile': 'mobile',
  'react': 'react',
  'blockchain': 'blockchain',
  'data science': 'datascience',
  'developer productivity': 'productivity',
};

async function fetchDevToArticles(limit = 15) {
  const res = await axios.get('https://dev.to/api/articles', {
    params: { per_page: limit, top: 1 },
    headers: { 'User-Agent': 'TrendForge-Bot/2.0 (trending aggregator)' },
    timeout: 15000,
  });

  const articles = mapArticles(res.data);
  console.log(`[Dev.to] Fetched ${articles.length} top articles`);
  return articles;
}

async function fetchDevToByInterests(interests = [], limit = 15) {
  const allArticles = [];
  const seen = new Set();

  const general = await fetchDevToArticles(limit).catch(() => []);
  for (const a of general) {
    if (!seen.has(a.url)) { seen.add(a.url); allArticles.push(a); }
  }

  const tags = interests
    .map(i => INTEREST_TAG_MAP[i.toLowerCase()])
    .filter(Boolean)
    .slice(0, 3);

  for (const tag of tags) {
    try {
      const res = await axios.get('https://dev.to/api/articles', {
        params: { per_page: 5, tag, top: 7 },
        headers: { 'User-Agent': 'TrendForge-Bot/2.0 (trending aggregator)' },
        timeout: 15000,
      });
      for (const a of mapArticles(res.data)) {
        if (!seen.has(a.url)) { seen.add(a.url); allArticles.push(a); }
      }
    } catch {}
  }

  console.log(`[Dev.to] Fetched ${allArticles.length} articles across ${tags.length + 1} categories`);
  return allArticles.slice(0, limit);
}

function mapArticles(data) {
  return (data || []).map(article => ({
    title: article.title,
    url: article.url,
    author: article.user?.name || article.user?.username || 'unknown',
    tags: article.tag_list || [],
    reactions: article.public_reactions_count || 0,
    comments: article.comments_count || 0,
    readingTime: article.reading_time_minutes || 0,
    publishedAt: article.published_at,
  }));
}

module.exports = { fetchDevToArticles, fetchDevToByInterests };
