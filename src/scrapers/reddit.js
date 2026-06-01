const axios = require('axios');
const cheerio = require('cheerio');

const DEFAULT_SUBREDDITS = [
  'programming',
  'SideProject',
  'webdev',
  'opensource',
  'MachineLearning',
  'devops',
];

async function fetchRedditHot(subreddits = DEFAULT_SUBREDDITS, limit = 5) {
  const results = [];

  for (const sub of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${sub}/hot.rss`;
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        timeout: 15000,
      });

      const $ = cheerio.load(res.data, { xmlMode: true });
      const posts = [];

      $('entry').each((_, el) => {
        const title = $(el).find('title').text().trim();
        const link = $(el).find('link').attr('href') || '';
        const author = $(el).find('author name').text().trim();
        const content = $(el).find('content').text();

        if (title && posts.length < limit) {
          const scoreMatch = content.match(/(\d+)\s*(?:point|upvote)/i);
          const commentMatch = content.match(/(\d+)\s*comment/i);

          posts.push({
            title,
            url: link,
            redditUrl: link,
            subreddit: sub,
            score: scoreMatch ? parseInt(scoreMatch[1], 10) : 0,
            comments: commentMatch ? parseInt(commentMatch[1], 10) : 0,
            author: author || 'unknown',
          });
        }
      });

      results.push(...posts);
    } catch (err) {
      console.warn(`[Reddit] Failed to fetch r/${sub}: ${err.message}`);
    }
  }

  console.log(`[Reddit] Fetched ${results.length} posts across ${subreddits.length} subreddits`);
  return results;
}

module.exports = { fetchRedditHot, DEFAULT_SUBREDDITS };
