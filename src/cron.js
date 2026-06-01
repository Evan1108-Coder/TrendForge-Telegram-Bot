const cron = require('node-cron');
const { generateDailyReport } = require('./report');

function startCron(bot) {
  const job = cron.schedule('0 6 * * *', async () => {
    console.log('[CRON] Running daily report at 6AM HKT...');
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) {
      console.error('[CRON] No TELEGRAM_CHAT_ID set. Cannot send daily report.');
      return;
    }

    try {
      const report = await generateDailyReport();
      try {
        await bot.api.sendMessage(chatId, report, { parse_mode: 'Markdown' });
      } catch {
        await bot.api.sendMessage(chatId, report.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, ''));
      }
      console.log('[CRON] Daily report sent successfully.');
    } catch (err) {
      console.error('[CRON] Failed to send daily report:', err.message);
      try {
        await bot.api.sendMessage(chatId, '⚠️ TrendForge daily report failed. Check logs.');
      } catch {}
    }
  }, {
    timezone: 'Asia/Hong_Kong',
  });

  console.log('[CRON] Scheduled daily report for 06:00 HKT');
  return job;
}

module.exports = { startCron };
