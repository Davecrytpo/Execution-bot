# Hugging Face Spaces Deployment

This repo is ready for a private Hugging Face Space using the Docker SDK.

## Create the Space

1. Go to Hugging Face and create a new Space.
2. Use SDK `Docker`.
3. Set visibility to `Private`.
4. Connect this GitHub repo, or push these files to the Space repository.

## Required Secrets

Add these in the Space settings under repository secrets:

- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `API_SHARED_SECRET`
- `CUSTODY_MASTER_KEY`
- `HELIUS_RPC_URL`
- `HELIUS_WS_URL`
- `HELIUS_GATEKEEPER_RPC_URL`
- `ALCHEMY_RPC_URL`
- `JUPITER_API_KEY`
- `TELEGRAM_WEBHOOK_URL`

Set `TELEGRAM_WEBHOOK_URL` to:

```text
https://YOUR-USERNAME-execution-bot.hf.space/api/telegram/webhook
```

Optional secrets:

- `ALCHEMY_WS_URL`
- `DATABASE_SSL`
- `JUPITER_API_BASE_URL`
- `DEXSCREENER_BASE_URL`
- `PUMP_PROGRAM_ID`
- `TELEGRAM_WEBHOOK_SECRET`

If `TELEGRAM_WEBHOOK_SECRET` is not set, the app uses `API_SHARED_SECRET` as the Telegram webhook secret token.

## Health Check

After the Space builds, open:

```text
https://YOUR-USERNAME-execution-bot.hf.space/health
```

Expected response:

```json
{ "ok": true }
```

## Keep Awake

Use an uptime monitor to request this URL every 5 minutes:

```text
https://YOUR-USERNAME-execution-bot.hf.space/health
```

## Telegram Webhook

The app sets the Telegram webhook automatically on startup when `TELEGRAM_WEBHOOK_URL` is set.
