const cron = require('node-cron');
const { generateDailyReport } = require('./report');
const { loadPreferences } = require('./preferences');

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
    const maxLen = 4000;
    if (report.length <= maxLen) {
      await bot.api.sendMessage(chatId, report);
    } else {
      let remaining = report;
      while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
          await bot.api.sendMessage(chatId, remaining);
          break;
        }
        let splitAt = remaining.lastIndexOf('\n\n', maxLen);
        if (splitAt < maxLen * 0.3) splitAt = remaining.lastIndexOf('\n', maxLen);
        if (splitAt < maxLen * 0.3) splitAt = maxLen;
        await bot.api.sendMessage(chatId, remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).trimStart();
      }
    }
    console.log('[CRON] Report sent successfully.');
  } catch (err) {
    console.error('[CRON] Failed to send report:', err.message);
    try {
      await bot.api.sendMessage(chatId, 'TrendForge report failed this cycle. Check logs for details.');
    } catch {}
  }
}

function startCron(bot) {
  botRef = bot;
  const prefs = loadPreferences();

  if (prefs.reportEnabled === false) {
    console.log('[CRON] Reports disabled by user preference');
    return null;
  }

  const expr = prefs.reportCron || '0 6 * * *';

  if (!cron.validate(expr)) {
    console.error(`[CRON] Invalid cron expression: "${expr}". Falling back to daily 6AM.`);
    currentJob = cron.schedule('0 6 * * *', () => sendReport(bot), {
      timezone: prefs.timezone || 'Asia/Hong_Kong',
    });
    console.log('[CRON] Scheduled: Daily at 06:00 (fallback)');
    return currentJob;
  }

  const label = scheduleLabel(prefs);

  currentJob = cron.schedule(expr, () => {
    console.log(`[CRON] Running scheduled report (${label})...`);
    sendReport(bot);
  }, {
    timezone: prefs.timezone || 'Asia/Hong_Kong',
  });

  console.log(`[CRON] Scheduled: ${label} [${expr}]`);
  return currentJob;
}

function restartCron() {
  if (currentJob) {
    currentJob.stop();
    currentJob = null;
  }
  if (botRef) {
    return startCron(botRef);
  }
  return null;
}

module.exports = { startCron, restartCron, scheduleLabel };
