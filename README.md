# TrendForge Telegram Bot

AI-powered Telegram bot that monitors GitHub Trending and Hacker News daily, uses LLM to filter and generate personalized project ideas, and sends you a daily briefing.

## Features

- **Daily Trend Reports** — Automated 6AM HKT briefing combining GitHub Trending + Hacker News
- **Multi-Model LLM** — Supports 17 models across OpenAI, Anthropic, Google, Together AI, and MiniMax
- **Natural Conversation** — Chat naturally about tech trends, get project ideas, discuss what's hot
- **Personalized Filtering** — Set your interests, preferred languages, and idea style
- **Quick Commands** — Instant access to trending repos, HN stories, and on-demand reports

## Supported Models

| Provider | Models |
|----------|--------|
| OpenAI | gpt-5.4-pro, gpt-5.4-mini, gpt-4o, gpt-4o-mini |
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5, claude-3.5-sonnet |
| Google | gemini-3.1-pro, gemini-3-flash, gemini-2.5-flash-lite |
| Together AI | llama-4-maverick, llama-4-scout, llama-3.3-70b |
| MiniMax | minimax-m2.7, minimax-m2.5-lightning |

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and command list |
| `/report` | Generate today's AI-powered trend report |
| `/trending` | Quick view of GitHub trending repos |
| `/hn` | Quick view of Hacker News top stories |
| `/prefs` | View your taste profile |
| `/setinterests` | Set your interests (comma-separated) |
| `/setlangs` | Set preferred programming languages |
| `/setmodel` | Change the LLM model |
| `/models` | List all supported models with availability |
| `/idea <topic>` | Generate a project idea on any topic |
| `/help` | Show all commands |

Or just send a message to chat naturally!

## Quick Start

```bash
git clone https://github.com/Evan1108-Coder/TrendForge-Telegram-Bot.git
cd TrendForge-Telegram-Bot
npm install
cp .env.example .env
# Edit .env with your tokens
npm start
```

See [SETUP.md](SETUP.md) for detailed installation instructions.

## Architecture

```
src/
  index.js          — Entry point
  bot.js            — Telegram bot (grammy) with commands and conversation
  cron.js           — Daily report scheduler (6AM HKT)
  report.js         — Report generation combining scrapers + LLM
  preferences.js    — Taste profile management
  llm/
    providers.js    — Multi-provider LLM abstraction layer
  scrapers/
    github.js       — GitHub Trending scraper
    hackernews.js   — Hacker News API client
```

## License

MIT License - see [LICENSE](LICENSE)
