const axios = require('axios');
const cheerio = require('cheerio');

async function fetchGitHubTrending(language = '', since = 'daily') {
  const url = `https://github.com/trending/${encodeURIComponent(language)}?since=${since}`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'TrendForge-Bot/1.0' },
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

  return repos.slice(0, 25);
}

module.exports = { fetchGitHubTrending };
