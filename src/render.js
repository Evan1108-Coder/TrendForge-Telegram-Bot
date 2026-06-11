// Deterministic rendering of the daily report.
//
// The LLM is asked for a small, structured JSON payload (TL;DR lines, a few
// picks referenced by id, and a "signal of the day"). EVERYTHING factual —
// titles, URLs, star/vote/comment counts — comes from our own scraped data,
// looked up by id. The model only contributes prose (why-it-matters one-liners,
// the TL;DR, the signal). That keeps links real (no hallucinated URLs) and the
// layout consistent, while still reading like a short human briefing instead of
// a wall of text.

const { cleanOutput } = require('./utils/format');

const SOURCE_META = {
  github: { emoji: '🐙', label: 'GitHub', prefix: 'gh' },
  hn: { emoji: '📰', label: 'Hacker News', prefix: 'hn' },
  reddit: { emoji: '👽', label: 'Reddit', prefix: 'rd' },
  ph: { emoji: '🚀', label: 'Product Hunt', prefix: 'ph' },
  devto: { emoji: '✍️', label: 'Dev.to', prefix: 'dv' },
};

const SOURCE_ORDER = ['github', 'hn', 'reddit', 'ph', 'devto'];
const DEFAULT_LIMITS = { github: 12, hn: 10, reddit: 10, ph: 6, devto: 6 };

// Non-printing sentinel marking a hard split between Telegram messages. The
// renderer inserts it where one message should end and the next begin; the
// splitter (splitHtmlMessage) breaks on it and strips it, so it never reaches
// Telegram. Lets us deliver the report as exactly 2 clean messages.
const MSG_BREAK = '␞';

// --- escaping -------------------------------------------------------------

// Telegram HTML parse mode only needs &, <, > escaped in text nodes.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// href attribute values additionally must not contain a bare quote.
function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

// Strip markdown/HTML noise an LLM might emit, collapse to a single clean line.
function stripInline(value) {
  return String(value == null ? '' : value)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

function formatCount(value) {
  const n = Number(String(value == null ? '' : value).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) return String(value || '').trim();
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// --- canonical item mapping ----------------------------------------------

// Build the deterministic per-source metric line (numbers come from data only).
function buildMetric(raw, source) {
  switch (source) {
    case 'github': {
      const parts = [];
      const today = String(raw.starsToday || '').trim();
      if (today && today !== '0') {
        parts.push(/star|today/i.test(today) ? `⭐ ${today}` : `⭐ ${today} stars today`);
      }
      if (raw.totalStars) parts.push(`${formatCount(raw.totalStars)} stars`);
      if (raw.language && raw.language !== 'Unknown') parts.push(raw.language);
      return parts.join(' · ');
    }
    case 'hn': {
      // Omit zero counts so the metric line stays honest and uncluttered.
      const parts = [];
      if (Number(raw.score) > 0) parts.push(`🔼 ${formatCount(raw.score)} pts`);
      if (Number(raw.comments) > 0) parts.push(`💬 ${formatCount(raw.comments)}`);
      return parts.join(' · ');
    }
    case 'reddit': {
      // Reddit's RSS feed exposes no score/comment counts, so they're often 0 —
      // show them only when real, but always keep the subreddit for context.
      const parts = [];
      if (Number(raw.score) > 0) parts.push(`🔼 ${formatCount(raw.score)}`);
      if (Number(raw.comments) > 0) parts.push(`💬 ${formatCount(raw.comments)}`);
      if (raw.subreddit) parts.push(`r/${raw.subreddit}`);
      return parts.join(' · ');
    }
    case 'ph':
      // The Atom feed carries no vote count; don't fabricate "0 upvotes".
      return Number(raw.votes) > 0 ? `🔼 ${formatCount(raw.votes)} upvotes` : '';
    case 'devto': {
      const parts = [`❤️ ${formatCount(raw.reactions)}`];
      if (raw.readingTime) parts.push(`${raw.readingTime} min`);
      return parts.join(' · ');
    }
    default:
      return '';
  }
}

// Normalize a scraped record into a uniform item used by the renderer.
function toItem(raw, source) {
  let title;
  let desc = '';
  switch (source) {
    case 'github': title = raw.name; desc = raw.description; break;
    case 'hn': title = raw.title; break;
    case 'reddit': title = raw.title; break;
    case 'ph':
      title = raw.name;
      // The Atom feed appends "Discussion | Link" boilerplate to the tagline.
      desc = String(raw.tagline || '').replace(/(\s*\|?\s*(?:Discussion|Link))+\s*$/gi, '');
      break;
    case 'devto': title = raw.title; desc = Array.isArray(raw.tags) ? raw.tags.join(', ') : ''; break;
    default: title = raw.title || raw.name;
  }
  return {
    source,
    title: String(title || 'Untitled').trim(),
    url: String(raw.url || '').trim(),
    desc: stripInline(desc),
    metric: buildMetric(raw, source),
  };
}

// Build the id->item map plus a compact numbered candidate list for the prompt.
function buildCandidates(data, limits = {}) {
  const idMap = {};
  const lines = [];
  for (const source of SOURCE_ORDER) {
    const arr = Array.isArray(data[source]) ? data[source] : [];
    const cap = limits[source] || DEFAULT_LIMITS[source];
    arr.slice(0, cap).forEach((raw, i) => {
      const id = `${SOURCE_META[source].prefix}${i + 1}`;
      const item = toItem(raw, source);
      idMap[id] = item;
      const descPart = item.desc ? ` | ${truncate(item.desc, 140)}` : '';
      lines.push(`${id} | ${SOURCE_META[source].label} | ${item.title} | ${item.metric}${descPart}`);
    });
  }
  return { idMap, list: lines.join('\n'), count: lines.length };
}

// --- robust model JSON parsing -------------------------------------------

// Tolerate code fences, leading prose, and trailing commas around the JSON.
function parseModelJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = s.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

// --- HTML rendering -------------------------------------------------------

// Render one item. Inside a grouped section the source is already named by the
// section header, so `showEmoji:false` drops the per-line emoji to stop the long
// rundown from reading like an emoji bullet-dump.
function renderItemBlock(item, oneLiner, { showEmoji = true } = {}) {
  const emoji = SOURCE_META[item.source] ? SOURCE_META[item.source].emoji : '•';
  const lead = showEmoji ? `${emoji} ` : '';
  const titleHtml = item.url
    ? `<b><a href="${escapeAttr(item.url)}">${escapeHtml(item.title)}</a></b>`
    : `<b>${escapeHtml(item.title)}</b>`;
  const why = stripInline(oneLiner) || truncate(item.desc, 280);
  const head = why ? `${lead}${titleHtml} — ${escapeHtml(why)}` : `${lead}${titleHtml}`;
  const lines = [head];
  if (item.metric) lines.push(`<i>${escapeHtml(item.metric)}</i>`);
  return lines.join('\n');
}

// Render one entry of the overall Top 5: rank number, tappable title, a source
// tag (so the reader sees WHERE it's from at a glance), a medium description on
// its own line, and the deterministic metric. Numbers/links come from scraped
// data; only the description is LLM prose.
function renderRankedPick(item, summary, rank) {
  const meta = SOURCE_META[item.source];
  const tag = meta ? `${meta.emoji} ${meta.label}` : item.source;
  const titleHtml = item.url
    ? `<a href="${escapeAttr(item.url)}">${escapeHtml(item.title)}</a>`
    : escapeHtml(item.title);
  const lines = [`<b>${rank}. ${titleHtml}</b> · <i>${escapeHtml(tag)}</i>`];
  const why = stripInline(summary) || truncate(item.desc, 240);
  if (why) lines.push(escapeHtml(why));
  if (item.metric) lines.push(`<i>${escapeHtml(item.metric)}</i>`);
  return lines.join('\n');
}

// The overall report: a short TL;DR + the single best 5 projects across ALL
// sources (ranked, each tagged with its source), then a hard message break,
// then the Signal of the Day. No per-source sections — one combined ranking.
function renderOverallReport({ tldr, picks, signal, meta }) {
  const head = [];
  head.push(`🔨 <b>TrendForge Daily</b> · <i>${escapeHtml(meta.dateLabel)}</i>`);

  const tldrLines = (tldr || []).map((t) => stripInline(t)).filter(Boolean).slice(0, 3);
  if (tldrLines.length) {
    head.push(['<b>⚡ TL;DR</b>', ...tldrLines.map((t) => `• ${escapeHtml(t)}`)].join('\n'));
  }

  const pickBlocks = (picks || [])
    .filter((p) => p && p.item)
    .map((p, i) => renderRankedPick(p.item, p.oneLiner, i + 1));
  if (pickBlocks.length) {
    head.push(['<b>🏆 Top 5 Today</b>', '', pickBlocks.join('\n\n')].join('\n'));
  }

  // Second message: the signal and footer, kept short and clear.
  const tail = [];
  const signalText = stripInline(signal);
  if (signalText) tail.push(`<b>📡 Signal of the Day</b>\n${escapeHtml(signalText)}`);
  if (meta.footer) tail.push(`<i>${escapeHtml(meta.footer)}</i>`);

  const part1 = head.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!tail.length) return part1;
  const part2 = tail.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${part1}\n${MSG_BREAK}\n${part2}`;
}

// Shared skeleton: header, TL;DR, top picks, signal, footer. Content varies
// daily (LLM prose) but the structure stays scannable.
function renderSkeleton({ tldr, picks, signal, meta }) {
  const blocks = [];
  blocks.push(`🔨 <b>TrendForge Daily</b> · <i>${escapeHtml(meta.dateLabel)}</i>`);

  const tldrLines = (tldr || []).map((t) => stripInline(t)).filter(Boolean).slice(0, 3);
  if (tldrLines.length) {
    blocks.push(['<b>⚡ TL;DR</b>', ...tldrLines.map((t) => `• ${escapeHtml(t)}`)].join('\n'));
  }

  const pickBlocks = (picks || [])
    .filter((p) => p && p.item)
    .map((p) => renderItemBlock(p.item, p.oneLiner));
  if (pickBlocks.length) {
    blocks.push(['<b>🔥 Top Picks</b>', '', pickBlocks.join('\n\n')].join('\n'));
  }

  const signalText = stripInline(signal);
  if (signalText) {
    blocks.push(`<b>📡 Signal of the Day</b>\n${escapeHtml(signalText)}`);
  }

  if (meta.footer) blocks.push(`<i>${escapeHtml(meta.footer)}</i>`);

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Resolve model picks (by id) into real items; top up from candidates if the
// model returned too few valid ids.
function resolvePicks(modelPicks, idMap, desired = 3) {
  const picks = [];
  const used = new Set();
  for (const p of Array.isArray(modelPicks) ? modelPicks : []) {
    const id = String(p && p.id != null ? p.id : '').trim().toLowerCase();
    const item = idMap[id];
    if (item && !used.has(id)) {
      used.add(id);
      picks.push({ id, item, oneLiner: p.summary || p.one_liner || p.oneLiner || '' });
    }
    if (picks.length >= desired) break;
  }
  if (picks.length < desired) {
    for (const [id, item] of Object.entries(idMap)) {
      if (used.has(id)) continue;
      used.add(id);
      picks.push({ id, item, oneLiner: '' });
      if (picks.length >= desired) break;
    }
  }
  return picks;
}

// Render the full per-source listing: every candidate item, grouped under a
// bold source header, using the same one-item template. Descriptions come from
// scraped data (no extra LLM calls). Optionally skip ids already shown as picks
// so the highlights and the full list don't repeat each other.
function renderFullSections(idMap, { excludeIds = new Set(), details = {} } = {}) {
  const bySource = {};
  for (const [id, item] of Object.entries(idMap)) {
    if (excludeIds.has(id)) continue;
    (bySource[item.source] = bySource[item.source] || []).push({ id, item });
  }
  const sections = [];
  for (const source of SOURCE_ORDER) {
    const items = bySource[source];
    if (!items || !items.length) continue;
    const meta = SOURCE_META[source];
    // Prefer the LLM's detailed blurb for this id; fall back to the scraped description.
    const blocks = items.map(({ id, item }) =>
      renderItemBlock(item, details[id] || '', { showEmoji: false }));
    sections.push([`<b>${meta.emoji} ${meta.label}</b>`, '', blocks.join('\n\n')].join('\n'));
  }
  return sections;
}

// Render from the LLM's structured JSON.
function renderStructuredReport(parsed, idMap, meta) {
  const picks = resolvePicks(parsed.top_picks || parsed.topPicks, idMap, 3);
  return renderSkeleton({
    tldr: Array.isArray(parsed.tldr) ? parsed.tldr : (parsed.tl_dr || []),
    picks,
    signal: parsed.signal_of_day || parsed.signal || '',
    meta,
  });
}

// Assemble the full daily report: the scannable highlights (header, TL;DR, Top
// Picks, signal) followed by the complete per-source rundown so nothing is cut.
// `blocks` lets a caller (e.g. the fallback) reuse the same layout.
function assembleReport({ tldr, picks, signal, meta, idMap, details = {}, includeFull = true }) {
  const blocks = [];
  blocks.push(`🔨 <b>TrendForge Daily</b> · <i>${escapeHtml(meta.dateLabel)}</i>`);

  const tldrLines = (tldr || []).map((t) => stripInline(t)).filter(Boolean).slice(0, 3);
  if (tldrLines.length) {
    blocks.push(['<b>⚡ TL;DR</b>', ...tldrLines.map((t) => `• ${escapeHtml(t)}`)].join('\n'));
  }

  const pickBlocks = (picks || [])
    .filter((p) => p && p.item)
    .map((p) => renderItemBlock(p.item, p.oneLiner || details[p.id] || ''));
  if (pickBlocks.length) {
    blocks.push(['<b>🔥 Top Picks</b>', '', pickBlocks.join('\n\n')].join('\n'));
  }

  if (includeFull && idMap) {
    const excludeIds = new Set((picks || []).map((p) => p && p.id).filter(Boolean));
    const sections = renderFullSections(idMap, { excludeIds, details });
    if (sections.length) {
      blocks.push('<b>📋 The Full Rundown</b>');
      blocks.push(...sections);
    }
  }

  const signalText = stripInline(signal);
  if (signalText) {
    blocks.push(`<b>📡 Signal of the Day</b>\n${escapeHtml(signalText)}`);
  }

  if (meta.footer) blocks.push(`<i>${escapeHtml(meta.footer)}</i>`);

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Full report from the LLM's structured JSON: TL;DR + overall Top 5 (across all
// sources, ranked, source-tagged) + Signal. Delivered as 2 Telegram messages.
function renderFullReport(parsed, idMap, meta) {
  const picks = resolvePicks(parsed.top_5 || parsed.top_picks || parsed.topPicks, idMap, 5);
  let tldr = Array.isArray(parsed.tldr) ? parsed.tldr : (parsed.tl_dr || []);
  // Evan wants the TL;DR kept. Some models intermittently omit it, so guarantee
  // a clear one-liner deterministically from the ranking when the model gives none.
  if (!tldr.map((t) => stripInline(t)).filter(Boolean).length && picks.length && picks[0].item) {
    const where = meta.sources ? ` across ${meta.sources}` : '';
    tldr = [`Today's Top 5${where} — led by ${truncate(picks[0].item.title, 80)}.`];
  }
  return renderOverallReport({
    tldr,
    picks,
    signal: parsed.signal_of_day || parsed.signal || '',
    meta,
  });
}

// Render with no LLM (model unavailable or unparseable): deterministic pick of
// the strongest items across sources for the highlights, then the full rundown.
function renderFallbackReport(data, meta) {
  const { idMap } = buildCandidates(data);
  // Interleave one item from each source first so picks aren't all GitHub.
  const bySource = {};
  for (const [id, item] of Object.entries(idMap)) {
    (bySource[item.source] = bySource[item.source] || []).push({ id, item });
  }
  const picks = [];
  for (let round = 0; round < 5 && picks.length < 5; round++) {
    for (const source of SOURCE_ORDER) {
      const list = bySource[source];
      if (list && list[round]) {
        picks.push({ id: list[round].id, item: list[round].item, oneLiner: '' });
        if (picks.length >= 5) break;
      }
    }
  }
  const counts = SOURCE_ORDER
    .filter((s) => Array.isArray(data[s]) && data[s].length)
    .map((s) => `${data[s].length} ${SOURCE_META[s].label}`);
  const tldr = counts.length ? [`Today's pulse: ${counts.join(', ')}.`] : [];
  const signal = picks[0] ? `${picks[0].item.title} is leading today's trend list.` : '';
  return renderOverallReport({ tldr, picks, signal, meta });
}

// --- Telegram delivery ----------------------------------------------------

// Split on newline boundaries so we never cut an HTML tag in half (every tag we
// emit lives entirely on one line). Hard-chunk any pathologically long line.
function splitHtmlMessage(text, max = 4000) {
  if (!text) return [];
  // Honor explicit page breaks first (one Telegram message per segment), then
  // safety-chunk any segment that still exceeds the hard limit.
  const segments = text.includes(MSG_BREAK)
    ? text.split(MSG_BREAK).map((s) => s.replace(/^\n+|\n+$/g, '')).filter(Boolean)
    : [text];
  const out = [];
  for (const seg of segments) {
    if (seg.length <= max) {
      out.push(seg);
      continue;
    }
    let cur = '';
    for (const line of seg.split('\n')) {
      if (cur && cur.length + 1 + line.length > max) {
        out.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n${line}` : line;
      while (cur.length > max) {
        out.push(cur.slice(0, max));
        cur = cur.slice(max);
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

// Send the (HTML) report. If Telegram rejects the HTML (e.g. a parse error),
// retry that chunk as plain text so a daily report is NEVER silently dropped.
async function sendReportHTML(api, chatId, html) {
  const chunks = splitHtmlMessage(html, 4000);
  for (const chunk of chunks) {
    try {
      await api.sendMessage(chatId, chunk, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (err) {
      console.error('[Render] HTML send failed, retrying as plain text:', err.message);
      try {
        await api.sendMessage(chatId, cleanOutput(chunk) || chunk);
      } catch (err2) {
        console.error('[Render] Plain-text retry also failed:', err2.message);
      }
    }
  }
}

module.exports = {
  escapeHtml,
  escapeAttr,
  stripInline,
  toItem,
  buildMetric,
  buildCandidates,
  parseModelJson,
  renderStructuredReport,
  renderFullReport,
  renderFallbackReport,
  renderFullSections,
  renderSkeleton,
  resolvePicks,
  splitHtmlMessage,
  sendReportHTML,
  SOURCE_META,
  SOURCE_ORDER,
};
