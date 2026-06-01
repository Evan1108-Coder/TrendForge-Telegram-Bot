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
2. **Check timezone:** Reports send at 6AM HKT (22:00 UTC). Make sure your system clock is correct.
3. **Check logs:** Look for `[CRON]` messages in the logs
4. **Test manually:** Send `/report` to verify the report generation works

## GitHub trending returns empty

GitHub may rate-limit or block scraping. This is temporary. The bot will retry next cycle. If persistent:
- Check your internet connection
- Try accessing https://github.com/trending in a browser
- The bot gracefully degrades — HN data will still be included

## Hacker News returns empty

The Firebase API occasionally has outages. The bot will retry next cycle. GitHub data will still be included.

## LLM errors

- **Timeout:** Some models (especially large ones like gpt-5.4-pro or claude-opus-4-6) may take longer. The timeout is 120 seconds.
- **Rate limit:** If you get 429 errors, you're hitting API rate limits. Try a different model or wait.
- **Invalid key:** Double-check your API key. Make sure there are no extra spaces.
- **Model not found:** Use `/models` to see available models. Model names must match exactly.

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
| `ETIMEOUT` | Network timeout | Check internet connection |
