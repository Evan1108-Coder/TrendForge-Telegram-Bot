const { version: VERSION } = require('../package.json');
const { getAvailableModels, getAllModels } = require('./llm/providers');
const { loadPreferences } = require('./preferences');
const { scheduleLabel } = require('./cron');
const { listSchedules } = require('./schedules');
const { checkForUpdate } = require('./update');
const { evidenceSummary } = require('./utils/actionlog');
const { escapeHtml } = require('./utils/format');

const SELF_RE = /\b(latest version|what version|version are you|your version|who are you|what can you do|what are you|what can you|your sources|your config|your model|your status|update status|can you update|commands|capabilities)\b/i;

function isSelfContextQuery(text) {
  return SELF_RE.test(String(text || ''));
}

function getSelfContext(chatId, opts = {}) {
  const prefs = opts.prefs || loadPreferences();
  const available = getAvailableModels();
  const all = getAllModels();
  const activeModel = available.includes(prefs.model) ? prefs.model : (available[0] || 'none');
  const schedules = listSchedules().filter(s => s.source === 'custom');
  let update = 'not checked in this response';
  if (opts.checkUpdate) {
    try {
      const info = checkForUpdate();
      update = info.available ? `update available (${info.behind} commit${info.behind === 1 ? '' : 's'} behind)` : 'already on latest origin/main';
    } catch (e) {
      update = `could not check update: ${e.message}`;
    }
  }
  return {
    name: 'TrendForge',
    version: VERSION,
    repo: 'Evan1108-Coder/TrendForge-Telegram-Bot',
    pm2: process.env.PM2_PROCESS_NAME || 'trendforge',
    activeModel,
    configuredModels: `${available.length}/${all.length}`,
    timezone: prefs.timezone,
    dailyReport: prefs.reportEnabled === false ? 'off' : scheduleLabel(prefs),
    enabledSources: (prefs.enabledSources && prefs.enabledSources.length ? prefs.enabledSources : ['github','hn','reddit','ph','devto']).join(', '),
    customSchedules: schedules.length,
    update,
    recentEvidence: evidenceSummary(chatId),
  };
}

function selfContextText(chatId, opts = {}) {
  const c = getSelfContext(chatId, opts);
  return [
    `Bot: ${c.name} v${c.version}`,
    `Repo/process: ${c.repo} / ${c.pm2}`,
    `Model: ${c.activeModel} (${c.configuredModels} configured)`,
    `Sources: ${c.enabledSources}`,
    `Schedule: ${c.dailyReport}; custom schedules=${c.customSchedules}; timezone=${c.timezone}`,
    `Update: ${c.update}`,
    `Capabilities: trend reports, GitHub/HN/Reddit/Product Hunt/Dev.to fetches, project ideas, reminders, schedules, notes, file/image analysis, safe read-only shell/http fetch.`,
    `Recent evidence:\n${c.recentEvidence}`,
  ].join('\n');
}

function renderSelfContext(chatId, opts = {}) {
  const c = getSelfContext(chatId, { ...opts, checkUpdate: true });
  return [
    `🧭 <b>${escapeHtml(c.name)} v${escapeHtml(c.version)}</b>`,
    `<b>Repo/process:</b> <code>${escapeHtml(c.repo)}</code> / <code>${escapeHtml(c.pm2)}</code>`,
    `<b>Model:</b> <code>${escapeHtml(c.activeModel)}</code> <i>(${escapeHtml(c.configuredModels)} configured)</i>`,
    `<b>Sources:</b> ${escapeHtml(c.enabledSources)}`,
    `<b>Schedule:</b> ${escapeHtml(c.dailyReport)} · custom schedules: ${c.customSchedules} · ${escapeHtml(c.timezone || 'timezone unknown')}`,
    `<b>Update:</b> ${escapeHtml(c.update)}`,
    '',
    '<b>What I can do:</b>',
    '• Fetch live trend data and write structured reports',
    '• Generate project ideas from current sources',
    '• Manage schedules, reminders, notes, and file/image analysis',
    '• Run safe read-only HTTP/shell checks when needed',
    '',
    '<b>Recent recorded evidence:</b>',
    `<pre>${escapeHtml(c.recentEvidence).slice(0, 1200)}</pre>`,
  ].join('\n');
}

module.exports = { isSelfContextQuery, getSelfContext, selfContextText, renderSelfContext };
