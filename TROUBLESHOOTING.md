# Troubleshooting

## Bot doesn't respond

1. **Check the bot is running:** `pm2 status` or check terminal output
2. **Check the token:** Make sure `TELEGRAM_BOT_TOKEN` in `.env` is correct
3. **Check logs:** `pm2 logs trendforge` or check terminal output for errors
4. **Conflict:** Only one instance can run per token. Stop any other instances: `pm2 stop all`

## "No LLM available" error

You need at least one API key set in `.env`. The cheapest option is MiniMax:
```
MINIMAX_API_KEY=your-key-here
```

Check which models are available: send `/models` to the bot.

## Daily report not sending

1. **Check `TELEGRAM_CHAT_ID`** is set in `.env`
2. **Check timezone:** Reports send at 6AM HKT (UTC+8). Make sure your system clock is correct.
3. **Check logs:** Look for `[CRON]` messages in the logs
4. **Test manually:** Send `/report` to verify the report generation works

## Data source issues

TrendForge v2.0 fetches from 5 sources. If one fails, the others still work:

| Source | Method | Common Issues |
|--------|--------|---------------|
| GitHub Trending | HTML scraping | Rate limiting, layout changes |
| Hacker News | Firebase API | Occasional API outages |
| Reddit | RSS feeds | Rate limiting (fetches from 6 subreddits) |
| Product Hunt | Atom feed | Layout changes, empty on weekends |
| Dev.to | REST API | Rate limiting |

The bot has automatic retry with exponential backoff. If a source fails after retries, the report continues with available data.

When errors occur, the bot uses AI to explain what happened instead of showing raw error messages.

## LLM errors

- **Timeout:** Some models (especially large ones like gpt-5.4-pro or claude-opus-4-6) may take longer. The timeout is 120 seconds.
- **Rate limit:** If you get 429 errors, you're hitting API rate limits. Try a different model or wait.
- **Invalid key:** Double-check your API key. Make sure there are no extra spaces.
- **Model not found:** Use `/models` to see available models. Model names must match exactly.
- **MiniMax think tags:** Handled automatically. If you see `<think>` tags in responses, update to latest version.

## pm2 issues

**Bot not starting on reboot:**
```bash
pm2 startup
pm2 save
```

**Memory issues:**
```bash
pm2 restart trendforge --max-memory-restart 500M
```

**Logs too large:**
```bash
pm2 flush trendforge
```

## Preferences reset

`preferences.json` is created in the project root. If you delete it, defaults are restored. To backup:
```bash
cp preferences.json preferences.backup.json
```

## Common Error Messages

| Error | Cause | Fix |
|-------|-------|-----|
| `TELEGRAM_BOT_TOKEN not set` | Missing .env or token | Check .env file exists and has token |
| `Unknown model: X` | Typo in model name | Use `/models` to see exact names |
| `No API key set for X` | Missing API key for chosen model | Add the key to .env or `/setmodel` to a different model |
| `409 Conflict` | Another bot instance is running | Stop the other instance |
| `ETIMEOUT` | Network timeout | Check internet connection, bot will auto-retry |
| `403 Forbidden` | Source blocking requests | Temporary, will retry. Check if source is accessible in browser |
| `429 Too Many Requests` | API rate limit | Wait a few minutes or switch to a different model |
