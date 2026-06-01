require('dotenv').config();
const { createBot } = require('./bot');
const { startCron } = require('./cron');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN not set in .env');
  process.exit(1);
}

async function main() {
  console.log('🔨 TrendForge starting...');
  const bot = createBot(TOKEN);

  bot.catch((err) => {
    console.error('Bot error:', err.message);
  });

  startCron(bot);

  await bot.start({
    onStart: (info) => {
      console.log(`🔨 TrendForge bot running as @${info.username}`);
      console.log(`   Model: ${require('./preferences').loadPreferences().model}`);
      console.log(`   Daily report: 06:00 HKT`);
    },
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
