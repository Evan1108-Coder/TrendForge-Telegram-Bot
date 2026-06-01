const axios = require('axios');
const cheerio = require('cheerio');

const LANGUAGE_MAP = {
  'javascript': 'javascript',
  'js': 'javascript',
  'typescript': 'typescript',
  'ts': 'typescript',
  'python': 'python',
  'rust': 'rust',
  'go': 'go',
  'golang': 'go',
  'java': 'java',
  'c++': 'c++',
  'cpp': 'c++',
  'c#': 'c%23',
  'csharp': 'c%23',
  'ruby': 'ruby',
  'swift': 'swift',
  'kotlin': 'kotlin',
  'php': 'php',
};

async function fetchGitHubTrending(language = '', since = 'daily') {
  const url = `https://github.com/trending/${encodeURIComponent(language)}?since=${since}`;
  const repos = await scrapeTrendingPage(url);
  console.log(`[GitHub] Fetched ${repos.length} trending repos${language ? ` (${language})` : ''}`);
  return repos.slice(0, 25);
}

async function fetchGitHubTrendingByPrefs(languages = [], limit = 25) {
  const allRepos = [];
  const seen = new Set();

  const general = await scrapeTrendingPage('https://github.com/trending?since=daily').catch(() => []);
  for (const r of general) {
    if (!seen.has(r.name)) { seen.add(r.name); allRepos.push(r); }
  }

  const langFetches = languages
    .map(l => LANGUAGE_MAP[l.toLowerCase()])
    .filter(Boolean)
    .slice(0, 3);

  for (const lang of langFetches) {
    const repos = await scrapeTrendingPage(`https://github.com/trending/${lang}?since=daily`).catch(() => []);
    for (const r of repos) {
      if (!seen.has(r.name)) { seen.add(r.name); allRepos.push(r); }
    }
  }

  console.log(`[GitHub] Fetched ${allRepos.length} trending repos across ${langFetches.length + 1} categories`);
  return allRepos.slice(0, limit);
}

async function scrapeTrendingPage(url) {
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'TrendForge-Bot/2.0 (trending aggregator)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    timeout: 30000,
  });
  const $ = cheerio.load(res.data);
  const repos = [];

  $('article.Box-row').each((_, el) => {
    const nameEl = $(el).find('h2 a');
    const fullName = nameEl.text().replace(/\s/g, '').trim();
    const href = nameEl.attr('href');
    const description = $(el).find('p.col-9').text().trim();
    const lang = $(el).find('[itemprop="programmingLanguage"]').text().trim();
    const starsToday = $(el).find('.d-inline-block.float-sm-right').text().trim();
    const totalStarsEl = $(el).find('a[href$="/stargazers"]');
    const totalStars = totalStarsEl.text().trim().replace(/,/g, '');

    if (fullName) {
      repos.push({
        name: fullName,
        url: `https://github.com${href}`,
        description: description || 'No description',
        language: lang || 'Unknown',
        starsToday: starsToday || '0',
        totalStars: totalStars || '0',
      });
    }
  });

  return repos;
}

module.exports = { fetchGitHubTrending, fetchGitHubTrendingByPrefs };
