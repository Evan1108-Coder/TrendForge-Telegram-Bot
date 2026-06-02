require('dotenv').config();
const { createBot } = require('./bot');
const { startCron } = require('./cron');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('[Fatal] TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}

async function main() {
  console.log('🔨 TrendForge v3.0 starting...');
  const bot = createBot(TOKEN);

  bot.catch((err) => {
    console.error('[Bot] Unhandled error:', err.message);
  });

  startCron(bot);

  await bot.start({
    onStart: (info) => {
      const prefs = require('./preferences').loadPreferences();
      const { getAvailableModels } = require('./llm/providers');
      const { scheduleLabel } = require('./cron');
      const available = getAvailableModels();
      console.log(`🔨 TrendForge v3.0 running as @${info.username}`);
      console.log(`   Model: ${prefs.model}`);
      console.log(`   Available models: ${available.length}`);
      console.log(`   Sources: GitHub, HN, Reddit, Product Hunt, Dev.to`);
      console.log(`   Report schedule: ${scheduleLabel(prefs)}`);
      console.log(`   Timezone: ${prefs.timezone}`);
      if (process.env.TELEGRAM_CHAT_ID) {
        console.log(`   Auto-report chat: ${process.env.TELEGRAM_CHAT_ID}`);
      } else {
        console.log(`   ⚠️  TELEGRAM_CHAT_ID not set — auto-reports disabled`);
      }
    },
  });
}

main().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
