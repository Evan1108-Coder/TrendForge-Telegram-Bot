const cron = require('node-cron');
const { generateDailyReport } = require('./report');
const { loadPreferences } = require('./preferences');
const { startAllSchedules, restartAllSchedules, stopAllSchedules } = require('./schedules');
const { sendReportHTML } = require('./render');
const { cleanOutput } = require('./utils/format');
const { remember } = require('./utils/actionlog');
const { handleError } = require('./errors');
const { checkForUpdate, formatUpdateNotice } = require('./update');

let currentJob = null;
let botRef = null;
let updateCheckJob = null;
// Remote commit we last told the user about, so the recurring check doesn't
// re-notify for the same pending update every interval.
let lastNotifiedRemote = null;

// How often to check GitHub for a new version (every 6 hours).
const UPDATE_CHECK_CRON = '0 */6 * * *';

async function checkForUpdateAndNotify(bot) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return;
  let info;
  try {
    info = checkForUpdate();
  } catch (e) {
    // Auto-checks fail quietly (e.g. offline) — never spam the user about a
    // background check that couldn't run.
    console.error('[CRON] Update check skipped:', e.message);
    return;
  }
  if (!info.available) return;
  if (info.remote === lastNotifiedRemote) return; // already announced this one
  lastNotifiedRemote = info.remote;
  try {
    await bot.api.sendMessage(chatId, formatUpdateNotice(info));
    console.log(`[CRON] Notified user of available update (${info.remoteVersion || info.behind + ' commits'}).`);
  } catch (e) {
    console.error('[CRON] Could not send update notice:', e.message);
  }
}

function startUpdateChecker(bot) {
  if (updateCheckJob) {
    updateCheckJob.stop();
    updateCheckJob = null;
  }
  const prefs = loadPreferences();
  updateCheckJob = cron.schedule(UPDATE_CHECK_CRON, () => {
    console.log('[CRON] Running scheduled update check…');
    checkForUpdateAndNotify(bot);
  }, { timezone: prefs.timezone || 'Asia/Hong_Kong' });
  console.log(`[CRON] Update checker active [${UPDATE_CHECK_CRON}]`);
}

function scheduleLabel(prefs) {
  if (prefs.reportEnabled === false) return 'Disabled';
  return prefs.reportScheduleText || `Cron: ${prefs.reportCron || '0 6 * * *'}`;
}

async function sendReport(bot) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.error('[CRON] No TELEGRAM_CHAT_ID set. Cannot send report.');
    return;
  }
  try {
    const report = await generateDailyReport();
    await sendReportHTML(bot.api, chatId, report);
    const plainReport = cleanOutput(report).slice(0, 8000);
    remember(chatId, { action: 'sent scheduled daily trend report', evidence: plainReport.slice(0, 1200), result: 'Scheduled report sent; use it as context for follow-up questions.', cost: 'not reported by provider' });
    console.log('[CRON] Default report sent successfully.');
  } catch (err) {
    console.error('[CRON] Failed to send report:', err.message);
    try {
      const explanation = await handleError({ err, where: 'the scheduled daily report' });
      await bot.api.sendMessage(chatId, explanation);
    } catch (e2) {
      console.error('[CRON] Could not send failure notice:', e2.message);
    }
  }
}

function startCron(bot) {
  botRef = bot;
  const prefs = loadPreferences();

  startAllSchedules(bot);

  // Update checking is independent of report pausing — keep watching for new
  // versions even when automatic reports are muted.
  startUpdateChecker(bot);

  if (prefs.paused) {
    console.log('[CRON] Paused — no automatic reports until /resume');
    return null;
  }

  if (prefs.reportEnabled === false) {
    console.log('[CRON] Default report disabled by preference');
    return null;
  }

  const expr = prefs.reportCron || '0 6 * * *';

  if (!cron.validate(expr)) {
    console.error(`[CRON] Invalid cron expression: "${expr}". Falling back to daily 6AM.`);
    currentJob = cron.schedule('0 6 * * *', () => sendReport(bot), {
      timezone: prefs.timezone || 'Asia/Hong_Kong',
    });
    console.log('[CRON] Scheduled default report: Daily at 06:00 (fallback)');
    return currentJob;
  }

  const label = scheduleLabel(prefs);

  currentJob = cron.schedule(expr, () => {
    console.log(`[CRON] Running default report (${label})...`);
    sendReport(bot);
  }, {
    timezone: prefs.timezone || 'Asia/Hong_Kong',
  });

  console.log(`[CRON] Default report: ${label} [${expr}]`);
  return currentJob;
}

function stopCron() {
  if (currentJob) {
    currentJob.stop();
    currentJob = null;
  }
  // Note: the update checker is intentionally NOT stopped here — it runs
  // independently of report pausing (startUpdateChecker self-dedups on restart).
  stopAllSchedules();
}

function restartCron() {
  if (currentJob) {
    currentJob.stop();
    currentJob = null;
  }
  restartAllSchedules();
  if (botRef) {
    return startCron(botRef);
  }
  return null;
}

module.exports = { startCron, restartCron, stopCron, scheduleLabel };
