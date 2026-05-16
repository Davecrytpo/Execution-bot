# Render Deploy Guide

This guide deploys the bot stack on Render using the included `render.yaml` Blueprint and an external Neon Postgres database.

## What Gets Deployed

- `solana-telegram-execution-api` as the public web service
- `solana-telegram-execution-bot` as the Telegram polling worker
- `solana-telegram-execution-worker` as the execution queue worker
- `solana-telegram-execution-monitor` as the monitor worker
- `solana-telegram-execution-sniper` as the pump.fun sniper worker

## Before You Start

Make sure you already have:

- A GitHub repo containing this project
- A Render account connected to GitHub
- A Neon database connection string
- A valid Telegram bot token from BotFather
- Helius RPC and WebSocket URLs
- A Jupiter API key
- A strong `CUSTODY_MASTER_KEY`

Recommended:

- Keep the Neon database region close to your app region when possible
- Use a long random `CUSTODY_MASTER_KEY` and store it securely
- Fund at least one test wallet before live trading

## Required Secrets

You will be prompted to enter or manually add these values:

- `TELEGRAM_BOT_TOKEN`
- `CUSTODY_MASTER_KEY`
- `SOLANA_RPC`
- `HELIUS_RPC_URL`
- `HELIUS_WS_URL`
- `HELIUS_GATEKEEPER_RPC_URL`
- `ALCHEMY_RPC_URL`
- `ALCHEMY_WS_URL`
- `JUPITER_API_KEY`

Render will generate or provide:

- `API_SHARED_SECRET` from the Blueprint

You must provide:

- `DATABASE_URL` from Neon

Set by the Blueprint:

- all default timing, sniper, and rate-limit settings

## Deployment Steps

1. Push the repository to GitHub.
2. In Render, open `Blueprints`.
3. Click `New Blueprint Instance`.
4. Select this repository.
5. Confirm that Render detects `render.yaml`.
6. Review the service list and continue.
7. Enter values for every `sync: false` environment variable when Render prompts for them.
8. Create the Blueprint instance.

Render will then:

- build the Node services
- run `npm run migrate` as the API pre-deploy command
- start the API and all workers

## First Deploy Checks

After deployment finishes, verify the following in order.

### 1. API Health

Open the API service URL and check:

```text
GET /health
```

Expected response:

```json
{ "ok": true }
```

### 2. Admin Summary

In the API service environment variables, copy `API_SHARED_SECRET`.

Call:

```text
GET /api/admin/summary
x-api-key: <API_SHARED_SECRET>
```

Expected result:

- JSON response instead of `401`
- no database error

### 3. Worker Status

In Render logs, confirm:

- bot worker stays running
- executor worker stays running
- monitor worker stays running
- sniper worker stays running

Look for the absence of:

- database connection failures
- repeated Telegram HTTP failures
- repeated RPC/WebSocket startup failures

### 4. Telegram Smoke Test

In Telegram:

1. Send `/start`
2. Send `/menu`
3. Send `/wallet`
4. Confirm a wallet is created and returned

### 5. Signal API Smoke Test

Send a test signal to the API:

```http
POST /api/signals
x-api-key: <API_SHARED_SECRET>
Content-Type: application/json
```

```json
{
  "signalKey": "render-smoke-buy-1",
  "mint": "So11111111111111111111111111111111111111112",
  "source": "pumpfun",
  "side": "BUY",
  "score": 80,
  "payload": {
    "symbol": "SOL",
    "reason": "render smoke test"
  }
}
```

Expected behavior:

- API accepts the request
- signal appears in admin metrics or summary
- no runtime crash in workers

## Important Production Notes

- Do not commit `.env` to GitHub.
- Do not rotate `CUSTODY_MASTER_KEY` after wallets exist unless you are doing a planned re-encryption migration.
- Keep `sslmode=require` in the Neon `DATABASE_URL`.
- If you later add new `sync: false` variables to `render.yaml`, Render will not automatically prompt for them on an existing Blueprint. Add them manually in the dashboard.

## If Deployment Fails

### Migration Fails

Check:

- `DATABASE_URL` is the Neon connection string
- API pre-deploy logs for SQL errors

### API Fails Health Check

Check:

- build completed successfully
- `PORT` was not hardcoded away from Render defaults
- `/health` still returns success locally

### Bot Worker Fails

Check:

- `TELEGRAM_BOT_TOKEN`
- outbound network access in logs
- Telegram bot has not been revoked

### Sniper Worker Fails

Check:

- `HELIUS_RPC_URL`
- `HELIUS_WS_URL`
- `ALCHEMY_RPC_URL`
- `ALCHEMY_WS_URL`

### Admin Endpoints Return 401

Check:

- request header is `x-api-key`
- value matches `API_SHARED_SECRET`

## Recommended Go-Live Sequence

1. Deploy the full stack on Render.
2. Confirm health checks and admin endpoints.
3. Test Telegram onboarding.
4. Test one manual trade path with a low-risk funded test wallet.
5. Test one withdrawal path with a small amount.
6. Only then enable auto-buy for live users.
