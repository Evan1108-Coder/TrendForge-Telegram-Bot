const cron = require('node-cron');
const { generateDailyReport } = require('./report');
const { loadPreferences } = require('./preferences');
const { startAllSchedules, restartAllSchedules, stopAllSchedules } = require('./schedules');
const { sendReportHTML } = require('./render');
const { handleError } = require('./errors');

let currentJob = null;
let botRef = null;

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
