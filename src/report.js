const { fetchGitHubTrendingByPrefs } = require('./scrapers/github');
const { fetchTopStories } = require('./scrapers/hackernews');
const { fetchRedditHot } = require('./scrapers/reddit');
const { fetchProductHunt } = require('./scrapers/producthunt');
const { fetchDevToByInterests } = require('./scrapers/devto');
const { chat, getAvailableModels } = require('./llm/providers');
const { loadPreferences } = require('./preferences');
const { memoriesForPrompt } = require('./memory');
const { withRetry } = require('./utils/retry');
const {
  buildCandidates,
  parseModelJson,
  renderFullReport,
  renderFallbackReport,
} = require('./render');

const SOURCE_LABELS = { github: 'GitHub', hn: 'HN', reddit: 'Reddit', ph: 'PH', devto: 'Dev.to' };

function dateLabel(timezone) {
  try {
    return new Date().toLocaleDateString('en-US', {
      timeZone: timezone || 'Asia/Hong_Kong',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
}

// Ask the model for a SMALL structured payload. It only writes prose; every
// fact (titles, links, metrics) is resolved from our data by id afterwards.
function buildPrompt(prefs, candidateList, memText) {
  const memBlock = memText
    ? `\nWHAT THE READER ASKED YOU TO REMEMBER (use to personalize ranking & framing; don't quote verbatim)\n${memText}\n`
    : '';
  return `You are TrendForge, a sharp daily tech-trend curator writing a SHORT briefing for one reader.

READER PROFILE
- Interests: ${prefs.interests.join(', ')}
- Preferred languages: ${prefs.languages.join(', ')}
- Avoid topics: ${prefs.avoidTopics.length ? prefs.avoidTopics.join(', ') : 'none'}
${memBlock}
TODAY'S CANDIDATES (one per line: "id | source | title | metric | description")
${candidateList}

Rank the SINGLE BEST 5 items for this reader across ALL sources COMBINED — one overall Top 5, not a per-source list. Be selective and varied; don't pick 5 of the same kind.

Return ONLY a JSON object (no prose, no markdown, no code fences) with EXACTLY this shape:
{
  "tldr": ["1-2 short, plain lines — the gist of today if they read nothing else"],
  "top_5": [
    {"id": "<candidate id, e.g. gh3>", "summary": "a MEDIUM description: about 2 sentences (not a one-liner, not a paragraph). Say what it is and why it matters to THIS reader."}
  ],
  "signal_of_day": "2-3 clear sentences naming ONE pattern connecting items across sources today, with the reasoning behind it"
}

RULES
- top_5: EXACTLY 5 objects, ranked best first. Each "id" MUST be a real id from the list above, and all 5 must be different. This is ONE overall cross-source ranking.
- summary: MEDIUM length — about 2 sentences each. Not a terse one-liner, not a wall of text. Concrete and substantive.
- tldr: REQUIRED, never empty — 1-2 short, plain lines a reader can grasp instantly. signal_of_day: clear and concise, not a wall of text.
- summary / tldr / signal: plain text only. No URLs, no markdown, no emoji, no HTML. (The source name and link are attached automatically — don't repeat them.)
- Base every description on the candidate's title/description provided above. Do NOT invent specific numbers, versions, dates, or facts that aren't given. Explaining and contextualizing is good; fabricating is not.`;
}

async function generateDailyReport() {
  const prefs = loadPreferences();

  const limits = {
    github: prefs.maxGitHubRepos,
    hn: prefs.maxHNStories,
    reddit: prefs.maxRedditPosts || 10,
    ph: prefs.maxPHProducts || 5,
    devto: prefs.maxDevToArticles || 5,
  };

  const allSources = ['github', 'hn', 'reddit', 'ph', 'devto'];
  const enabled = Array.isArray(prefs.enabledSources) && prefs.enabledSources.length
    ? prefs.enabledSources
    : allSources;
  const want = (s) => enabled.includes(s);

  const [githubRepos, hnStories, redditPosts, phProducts, devtoArticles] = await Promise.all([
    want('github') ? withRetry(() => fetchGitHubTrendingByPrefs(prefs.languages, prefs.maxGitHubRepos), { label: 'GitHub' }).catch((err) => {
      console.error('[Report] GitHub scrape failed:', err.message);
      return [];
    }) : Promise.resolve([]),
    want('hn') ? withRetry(() => fetchTopStories(prefs.maxHNStories), { label: 'HackerNews' }).catch((err) => {
      console.error('[Report] HN fetch failed:', err.message);
      return [];
    }) : Promise.resolve([]),
    want('reddit') ? withRetry(() => fetchRedditHot(), { label: 'Reddit' }).catch((err) => {
      console.error('[Report] Reddit fetch failed:', err.message);
      return [];
    }) : Promise.resolve([]),
    want('ph') ? withRetry(() => fetchProductHunt(), { label: 'ProductHunt' }).catch((err) => {
      console.error('[Report] Product Hunt fetch failed:', err.message);
      return [];
    }) : Promise.resolve([]),
    want('devto') ? withRetry(() => fetchDevToByInterests(prefs.interests), { label: 'DevTo' }).catch((err) => {
      console.error('[Report] Dev.to fetch failed:', err.message);
      return [];
    }) : Promise.resolve([]),
  ]);

  const data = { github: githubRepos, hn: hnStories, reddit: redditPosts, ph: phProducts, devto: devtoArticles };
  const sourcesUsed = Object.keys(SOURCE_LABELS).filter((s) => data[s] && data[s].length);

  if (sourcesUsed.length === 0) {
    return 'Could not fetch data from any source. Will retry next cycle.';
  }

  const model = prefs.model;
  const available = getAvailableModels();
  const activeModel = available.includes(model) ? model : available[0];

  const meta = {
    dateLabel: dateLabel(prefs.timezone),
    footer: '',
    sources: sourcesUsed.map((s) => SOURCE_LABELS[s]).join(', '),
  };

  const { idMap, list } = buildCandidates(data, limits);

  if (!activeModel) {
    meta.footer = `raw data · ${meta.sources}`;
    return renderFallbackReport(data, meta);
  }
  if (activeModel !== model) {
    console.log(`[Report] Model ${model} not available, falling back to ${activeModel}`);
  }
  meta.footer = `via ${activeModel} · ${meta.sources}`;

  try {
    const response = await chat(activeModel, [
      {
        role: 'system',
        content: 'You are TrendForge, a concise tech-trend curator. You ALWAYS reply with a single valid JSON object and nothing else.',
      },
      { role: 'user', content: buildPrompt(prefs, list, memoriesForPrompt()) },
    ]);

    const parsed = parseModelJson(response);
    if (!parsed) {
      console.warn('[Report] Could not parse model JSON, using deterministic fallback render.');
      return renderFallbackReport(data, meta);
    }
    return renderFullReport(parsed, idMap, meta);
  } catch (err) {
    console.error('[Report] LLM call failed:', err.message);
    meta.footer = `raw data · ${meta.sources}`;
    return renderFallbackReport(data, meta);
  }
}

module.exports = { generateDailyReport };
