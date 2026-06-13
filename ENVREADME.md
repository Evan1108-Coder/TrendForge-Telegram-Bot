# Environment Variables

TrendForge uses a `.env` file for configuration. Copy `.env.example` to `.env` and fill in your values.

## Required

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token from [@BotFather](https://t.me/BotFather) |

## Optional

| Variable | Description | Default |
|----------|-------------|---------|
| `TELEGRAM_CHAT_ID` | Chat ID for daily auto-reports. Without this, the cron job won't send reports (but `/report` still works on-demand) | - |
| `MINIMAX_API_KEY` | MiniMax API key for minimax-m3, minimax-m2.7, minimax-m2.5 | - |
| `OPENAI_API_KEY` | OpenAI API key for gpt-5.5-pro, gpt-5.5, gpt-5.5-mini, gpt-5.4-pro, gpt-5.4-mini, gpt-4o, gpt-4o-mini | - |
| `ANTHROPIC_API_KEY` | Anthropic API key for claude-opus-4-7, claude-sonnet-4-7, claude-opus-4-6, claude-sonnet-4-6, etc. | - |
| `GOOGLE_API_KEY` | Google AI API key for gemini-3.1-pro, gemini-3-flash, etc. | - |
| `TOGETHER_API_KEY` | Together AI API key for llama-4-maverick, llama-4-scout, llama-3.3-70b | - |

## Notes

- You need **at least one** LLM API key for AI-powered features (reports, ideas, conversation, error explanations)
- Without any LLM key, the bot still works for `/trending`, `/hn`, `/reddit`, `/ph`, `/devto` (raw data, no AI analysis)
- The default model is `minimax-m2.5`. Change with `/setmodel` or edit `preferences.json`
- `TELEGRAM_CHAT_ID` can be a user ID (positive number) or group ID (negative number)

## Getting Your Chat ID

1. Start the bot
2. Send any message to it
3. Check the logs - the chat ID will appear
4. Or use [@userinfobot](https://t.me/userinfobot) on Telegram

## Example .env

```
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=-1001234567890
MINIMAX_API_KEY=sk-api-xxxxx
OPENAI_API_KEY=sk-xxxxx
```
