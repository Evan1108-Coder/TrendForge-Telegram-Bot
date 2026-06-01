# Setup Guide

## Prerequisites

- Node.js 18+ (recommended: 20+)
- npm
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- At least one LLM API key

## Step 1: Clone and Install

```bash
git clone https://github.com/Evan1108-Coder/TrendForge-Telegram-Bot.git
cd TrendForge-Telegram-Bot
npm install
```

## Step 2: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your editor:

```bash
nano .env
```

**Required:** Set `TELEGRAM_BOT_TOKEN`
**Recommended:** Set at least one LLM API key (MiniMax is cheapest)
**Optional:** Set `TELEGRAM_CHAT_ID` for automated daily reports

See [ENVREADME.md](ENVREADME.md) for details on each variable.

## Step 3: Create Your Telegram Bot

1. Open Telegram, search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow the prompts to name your bot
4. Copy the token into your `.env` file

## Step 4: Run

**Direct:**
```bash
npm start
```

**With pm2 (recommended for production):**
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # auto-start on reboot
```

## Step 5: Get Your Chat ID (for daily reports)

1. Start the bot with `npm start`
2. Send `/start` to your bot on Telegram
3. Check the terminal logs for the chat ID
4. Add it to your `.env` as `TELEGRAM_CHAT_ID`
5. Restart the bot

## Step 6: Customize Preferences

Send these commands to your bot:

```
/setinterests AI, web dev, cloud, databases
/setlangs TypeScript, Python, Go
/setmodel minimax-m2.5-lightning
```

Or edit `preferences.json` directly.

## pm2 Commands

```bash
pm2 start ecosystem.config.js    # Start
pm2 stop trendforge              # Stop
pm2 restart trendforge           # Restart
pm2 logs trendforge              # View logs
pm2 status                       # Check status
```

## Updating

```bash
git pull
npm install
pm2 restart trendforge
```
