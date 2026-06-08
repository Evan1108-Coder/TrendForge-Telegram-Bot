# Security Policy

## Supported Versions

Security fixes are handled on the default branch unless a release branch is explicitly listed.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability. Email the maintainer or use GitHub's private vulnerability reporting when available. Include:

- Affected version or commit
- Steps to reproduce
- Impact and likelihood
- Any relevant logs with secrets removed

## Secret Handling

Never commit API keys, Telegram tokens, OAuth credentials, database files, `.env` files, or local user exports. Use `.env.example` for placeholders only.
