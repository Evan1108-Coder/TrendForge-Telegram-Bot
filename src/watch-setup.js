'use strict';

// watch-setup.js — TrendForge-specific wiring for the generic WatchManager.
//
// Registers the "did the thing happen?" probes TrendForge can watch for (a
// keyword starts trending on GitHub, a keyword hits the Hacker News front page,
// or a URL becomes reachable / changes) and exposes a shared singleton. Watches
// are OPT-IN: the agent only calls startWatch after the user agrees. Each poll
// is one cheap scrape/HTTP read; the guard caps in watch.js guarantee it ends.

const axios = require('axios');
const { WatchManager } = require('./watch');
const { fetchGitHubTrendingByPrefs } = require('./scrapers/github');
const { fetchTopStories } = require('./scrapers/hackernews');

let manager = null;

function registerProbes(wm) {
  // A keyword shows up in GitHub trending repo names/descriptions.
  wm.registerProbe('github_trending_keyword', async params => {
    const kw = String(params.keyword || '').toLowerCase();
    if (!kw) return { done: false };
    const repos = await fetchGitHubTrendingByPrefs([], 25).catch(() => []);
    const hit = repos.find(r =>
      (r.name || '').toLowerCase().includes(kw) ||
      (r.description || '').toLowerCase().includes(kw)
    );
    return { done: Boolean(hit), match: hit ? hit.name : undefined };
  });

  // A keyword hits the Hacker News front page (title match).
  wm.registerProbe('hn_front_page_keyword', async params => {
    const kw = String(params.keyword || '').toLowerCase();
    if (!kw) return { done: false };
    const stories = await fetchTopStories(30).catch(() => []);
    const hit = stories.find(s => (s.title || '').toLowerCase().includes(kw));
    return { done: Boolean(hit), match: hit ? hit.title : undefined };
  });

  // A URL becomes reachable (HTTP 2xx) — e.g. "tell me when the site is back up".
  wm.registerProbe('url_up', async params => {
    if (!params.url) return { done: false };
    try {
      const resp = await axios.get(params.url, { timeout: 10000, maxRedirects: 3, validateStatus: () => true });
      return { done: resp.status >= 200 && resp.status < 300, status: resp.status };
    } catch {
      return { done: false };
    }
  });

  // A URL's content changes vs a baseline length/snapshot.
  wm.registerProbe('url_changed', async params => {
    if (!params.url) return { done: false };
    try {
      const resp = await axios.get(params.url, { timeout: 10000, maxRedirects: 3, validateStatus: () => true });
      const len = String(resp.data || '').length;
      if (params.baselineLen == null) return { done: false, baselineLen: len };
      return { done: Math.abs(len - params.baselineLen) > (params.threshold || 50), len };
    } catch {
      return { done: false };
    }
  });

  return wm;
}

function getWatchManager(bot) {
  if (!manager) {
    manager = new WatchManager(bot, { maxConcurrent: 10 });
    registerProbes(manager);
  } else if (bot && !manager.bot) {
    manager.bot = bot;
  }
  return manager;
}

// Small NL → watch-spec extractor. Returns null if it isn't a watch request.
function parseWatchIntent(text) {
  const t = String(text || '').toLowerCase();
  if (!/\b(watch|monitor|keep an eye|let me know when|notify me when|tell me when|ping me when|alert me when)\b/.test(t)) return null;

  const urlMatch = (text || '').match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const url = urlMatch[0];
    if (/\b(up|back|online|reachable|live|deployed)\b/.test(t)) {
      return { kind: 'url_up', params: { url }, label: `${url} to come back up` };
    }
    return { kind: 'url_changed', params: { url }, label: `${url} to change` };
  }

  // "watch for X trending / on hacker news / on github"
  const kwMatch = t.match(/(?:for|when|about)\s+["“]?([a-z0-9 .+#-]{2,40}?)["”]?\s+(?:trend|show|appear|hit|land|is|starts|pops)/);
  const keyword = kwMatch ? kwMatch[1].trim() : null;
  if (keyword) {
    if (/hacker\s*news|hn\b/.test(t)) return { kind: 'hn_front_page_keyword', params: { keyword }, label: `“${keyword}” to hit the Hacker News front page` };
    return { kind: 'github_trending_keyword', params: { keyword }, label: `“${keyword}” to start trending on GitHub` };
  }
  return null;
}

module.exports = { getWatchManager, registerProbes, parseWatchIntent };
