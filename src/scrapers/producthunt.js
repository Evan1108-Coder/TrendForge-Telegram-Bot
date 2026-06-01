const axios = require('axios');
const cheerio = require('cheerio');

async function fetchProductHunt(limit = 10) {
  const url = 'https://www.producthunt.com/feed?category=undefined';
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/atom+xml, application/xml, text/xml',
    },
    timeout: 20000,
  });

  const $ = cheerio.load(res.data, { xmlMode: true });
  const products = [];

  $('entry').each((_, el) => {
    if (products.length >= limit) return false;

    const title = $(el).find('title').text().trim();
    const link = $(el).find('link[rel="alternate"]').attr('href') ||
                 $(el).find('link').attr('href') || '';
    const summary = $(el).find('summary, content').text().trim();

    const cleanSummary = summary
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 200);

    if (title) {
      products.push({
        name: title,
        tagline: cleanSummary || 'No description',
        url: link || 'https://www.producthunt.com',
        votes: 0,
      });
    }
  });

  console.log(`[ProductHunt] Fetched ${products.length} products from Atom feed`);
  return products;
}

module.exports = { fetchProductHunt };
