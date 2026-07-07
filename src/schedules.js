const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { sendReportHTML } = require('./render');
const { cleanOutput } = require('./utils/format');
const { remember } = require('./utils/actionlog');

const SCHEDULES_FILE = path.join(__dirname, '..', 'schedules.json');
const activeJobs = new Map();
let botRef = null;
let reportGeneratorFn = null;

function loadSchedules() {
  try {
    if (fs.existsSync(SCHEDULES_FILE)) {
      return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[Schedules] Failed to load:', e.message);
  }
  return {};
}

function saveSchedules(schedules) {
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2), 'utf-8');
}

function addSchedule(name, config) {
  if (!name || !config.cron) {
    return { success: false, error: 'Schedule needs a name and cron expression' };
  }
  if (!cron.validate(config.cron)) {
    return { success: false, error: `Invalid cron expression: "${config.cron}"` };
  }
  const schedules = loadSchedules();
  schedules[name] = {
    cron: config.cron,
    type: config.type || 'report',
    description: config.description || name,
    message: config.message || null,
    enabled: config.enabled !== false,
    createdAt: new Date().toISOString(),
  };
  saveSchedules(schedules);
  startScheduleJob(name, schedules[name]);
  return { success: true, name, cron: config.cron, description: schedules[name].description };
}

function removeSchedule(name) {
  const schedules = loadSchedules();
  if (!schedules[name]) {
    return { success: false, error: `Schedule "${name}" not found` };
  }
  if (activeJobs.has(name)) {
    activeJobs.get(name).stop();
    activeJobs.delete(name);
  }
  delete schedules[name];
  saveSchedules(schedules);
  return { success: true, removed: name };
}

function listSchedules() {
  const schedules = loadSchedules();
  const { loadPreferences } = require('./preferences');
  const prefs = loadPreferences();
  const result = [];

  result.push({
    name: 'default-report',
    cron: prefs.reportCron || '0 6 * * *',
    type: 'report',
    description: prefs.reportScheduleText || 'Default daily report',
    enabled: prefs.reportEnabled !== false,
    source: 'preferences',
  });

  for (const [name, config] of Object.entries(schedules)) {
    result.push({ name, ...config, source: 'custom' });
  }

  return result;
}

function startScheduleJob(name, config) {
  if (activeJobs.has(name)) {
    activeJobs.get(name).stop();
    activeJobs.delete(name);
  }
  if (!config.enabled) return;

  const { loadPreferences } = require('./preferences');
  const prefs = loadPreferences();
  const tz = prefs.timezone || 'Asia/Hong_Kong';

  const job = cron.schedule(config.cron, async () => {
    console.log(`[Schedules] Firing "${name}" (${config.description})`);
    await executeScheduledAction(name, config);
  }, { timezone: tz });

  activeJobs.set(name, job);
  console.log(`[Schedules] Active: "${name}" [${config.cron}] - ${config.description}`);
}

async function executeScheduledAction(name, config) {
  if (!botRef) return;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;

  try {
    if (config.type === 'report') {
      if (!reportGeneratorFn) {
        reportGeneratorFn = require('./report').generateDailyReport;
      }
      const report = await reportGeneratorFn();
      await sendReportHTML(botRef.api, chatId, report);
      const plainReport = cleanOutput(report).slice(0, 8000);
      remember(chatId, { action: `sent scheduled report: ${name}`, evidence: plainReport.slice(0, 1200), result: 'Scheduled report sent; use it as context for follow-up questions.', cost: 'not reported by provider' });
    } else if (config.type === 'message') {
      const msg = config.message || `Scheduled: ${config.description}`;
      await sendLongDirect(chatId, msg);
      remember(chatId, { action: `sent scheduled message: ${name}`, evidence: msg.slice(0, 1200), result: 'Scheduled message sent; use it as context for follow-up questions.', cost: 'none' });
    }
  } catch (e) {
    console.error(`[Schedules] Error in "${name}":`, e.message);
    try {
      const { handleError } = require('./errors');
      const explanation = await handleError({ err: e, where: `the scheduled report "${name}"` });
      await botRef.api.sendMessage(chatId, explanation);
    } catch (e2) {
      console.error(`[Schedules] Could not send failure notice for "${name}":`, e2.message);
    }
  }
}

async function sendLongDirect(chatId, text) {
  const maxLen = 4000;
  if (text.length <= maxLen) {
    await botRef.api.sendMessage(chatId, text);
    return;
  }
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      await botRef.api.sendMessage(chatId, remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    await botRef.api.sendMessage(chatId, remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
}

function startAllSchedules(bot) {
  botRef = bot;
  const { loadPreferences } = require('./preferences');
  if (loadPreferences().paused) {
    console.log('[Schedules] Paused — skipping all custom schedules');
    return;
  }
  const schedules = loadSchedules();
  let count = 0;
  for (const [name, config] of Object.entries(schedules)) {
    if (config.enabled) {
      startScheduleJob(name, config);
      count++;
    }
  }
  console.log(`[Schedules] Loaded ${count} custom schedule(s)`);
}

function stopAllSchedules() {
  for (const [, job] of activeJobs) {
    job.stop();
  }
  activeJobs.clear();
}

function restartAllSchedules() {
  stopAllSchedules();
  if (botRef) startAllSchedules(botRef);
}

module.exports = {
  addSchedule, removeSchedule, listSchedules,
  startAllSchedules, stopAllSchedules, restartAllSchedules,
  loadSchedules,
};
