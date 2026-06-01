const axios = require('axios');

const HN_API = 'https://hacker-news.firebaseio.com/v0';

async function fetchTopStories(limit = 30) {
  const res = await axios.get(`${HN_API}/topstories.json`, { timeout: 15000 });
  const ids = res.data.slice(0, limit);

  const stories = await Promise.all(
    ids.map(async (id) => {
      try {
        const item = await axios.get(`${HN_API}/item/${id}.json`, { timeout: 10000 });
        const d = item.data;
        if (!d || d.type !== 'story') return null;
        return {
          title: d.title,
          url: d.url || `https://news.ycombinator.com/item?id=${d.id}`,
          hnUrl: `https://news.ycombinator.com/item?id=${d.id}`,
          score: d.score || 0,
          comments: d.descendants || 0,
          by: d.by || 'unknown',
        };
      } catch {
        return null;
      }
    })
  );

  const result = stories.filter(Boolean).sort((a, b) => b.score - a.score);
  console.log(`[HackerNews] Fetched ${result.length} top stories`);
  return result;
}

module.exports = { fetchTopStories };
