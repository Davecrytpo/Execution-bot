# Render Free Guide

This guide deploys the bot in the cheapest workable hosted shape:

- `Neon` for PostgreSQL
- two `Render` free web services
- `UptimeRobot` hitting each `/health` endpoint every 5 minutes

This is a hobby or test setup, not a production deployment.

Do not deploy the root `render.yaml` Blueprint for the free setup. That Blueprint intentionally uses paid `starter` services. Follow the manual web-service steps below instead.

## How This Free Setup Works

This setup avoids paid Render background workers by running the long-lived processes as free web services with health endpoints.

The main free service runs:

- HTTP API
- Telegram bot
- execution worker
- monitor worker

It starts with:

```text
npm run start:render-free
```

The sniper free service runs only the sniper worker and a small health server:

```text
npm run start:sniper-web
```

Both services use the same `DATABASE_URL`. The sniper detects launches and writes queued signals to the database. The main service's executor worker reads those queued orders and executes them.

In the main free profile, the sniper worker is paused by default because it is the heaviest component and is the most likely to push a free Render instance over the `512Mi` memory limit.
On Render, Telegram delivery now switches to webhook mode automatically by using Render's `RENDER_EXTERNAL_URL`.

Migration should run in the Render build command, not in the start command. This helps the service pass Render health checks more reliably.

## What You Need

- a GitHub repo containing this project
- a Render account
- a Neon `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `CUSTODY_MASTER_KEY`
- `SOLANA_RPC`
- `HELIUS_RPC_URL`
- `HELIUS_WS_URL`
- `HELIUS_GATEKEEPER_RPC_URL`
- `ALCHEMY_RPC_URL`
- `ALCHEMY_WS_URL`
- `JUPITER_API_KEY`

Recommended:

- keep Neon in the same region as Render when possible
- use a long random `API_SHARED_SECRET`
- use a long random `CUSTODY_MASTER_KEY`

## Create The Main Render Service

1. Open the Render dashboard.
2. Click `New` -> `Web Service`.
3. Connect `https://github.com/Davecrytpo/Execution-bot.git`.
4. Select the `main` branch.
5. Choose a region close to your Neon database.
6. Set `Runtime` to `Node`.
7. Set `Instance Type` to `Free`.
8. Set `Build Command` to:

```text
npm ci && npm run build:render-free
```

9. Set `Start Command` to:

```text
npm run start:render-free
```

10. Set `Health Check Path` to:

```text
/health
```

## Create The Sniper Render Service

Create a second Render `Web Service` from the same repo and branch.

Use these settings:

- `Runtime`: `Node`
- `Instance Type`: `Free`
- `Build Command`: `npm ci && npm run build`
- `Start Command`: `npm run start:sniper-web`
- `Health Check Path`: `/health`

Use the same environment variables as the main service, especially the same `DATABASE_URL`, `API_SHARED_SECRET`, RPC URLs, and sniper settings.

For this sniper service, set:

- `ENABLE_TELEGRAM_BOT=false`
- `ENABLE_EXECUTOR_WORKER=false`
- `ENABLE_MONITOR_WORKER=false`
- `ENABLE_SNIPER_WORKER=true`
- `ENABLE_METRICS_SNAPSHOT_LOGS=false`

## Environment Variables

Add these in the Render dashboard:

- `DATABASE_URL=<your Neon connection string>`
- `API_SHARED_SECRET=<long random secret>`
- `TELEGRAM_BOT_TOKEN=<telegram token>`
- `CUSTODY_MASTER_KEY=<long random secret>`
- `SOLANA_RPC=<rpc url>`
- `HELIUS_RPC_URL=<helius rpc url>`
- `HELIUS_WS_URL=<helius websocket url>`
- `HELIUS_GATEKEEPER_RPC_URL=<helius backup rpc url>`
- `ALCHEMY_RPC_URL=<alchemy rpc url>`
- `ALCHEMY_WS_URL=<alchemy websocket url>`
- `JUPITER_API_KEY=<jupiter api key>`
- `JUPITER_API_BASE_URL=https://api.jup.ag/swap/v1`
- `DEXSCREENER_BASE_URL=https://api.dexscreener.com/latest/dex/tokens`
- `PUMP_PROGRAM_ID=6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- `POLL_INTERVAL_MS=250`
- `MONITOR_INTERVAL_MS=30000`
- `SIGNAL_RATE_LIMIT_WINDOW_MS=60000`
- `SIGNAL_RATE_LIMIT_MAX=120`
- `SIGNAL_REPLAY_WINDOW_SECONDS=300`
- `WORKER_FAILURE_ALERT_THRESHOLD=3`
- `WORKER_FAILURE_ALERT_WINDOW_MS=300000`
- `RPC_SLOT_LAG_THRESHOLD=15`
- `RPC_HEALTH_CACHE_MS=5000`
- `RPC_REQUEST_TIMEOUT_MS=10000`
- `RPC_ENDPOINT_COOLDOWN_MS=30000`
- `RPC_ERROR_LOG_COOLDOWN_MS=15000`
- `TX_CONFIRMATION_TIMEOUT_MS=60000`
- `WS_HEARTBEAT_MS=30000`
- `WS_FREEZE_THRESHOLD_MS=90000`
- `WS_RECONNECT_BASE_MS=2000`
- `WS_RECONNECT_MAX_MS=15000`
- `ENABLE_TELEGRAM_BOT=true`
- `ENABLE_EXECUTOR_WORKER=true`
- `ENABLE_MONITOR_WORKER=true`
- `ENABLE_SNIPER_WORKER=false`
- `ENABLE_METRICS_SNAPSHOT_LOGS=false`
- `TELEGRAM_WEBHOOK_URL=` optional, usually leave empty on Render
- `TELEGRAM_WEBHOOK_SECRET=` optional, otherwise the bot reuses `API_SHARED_SECRET`
- `SNIPER_ENABLE_DEXSCREENER=true`
- `SNIPER_WARMUP_MS=4000`
- `SNIPER_MOMENTUM_WINDOW_MS=10000`
- `SNIPER_PROCESSED_SIGNATURE_TTL_MS=1800000`
- `SNIPER_MAX_TRACKED_TOKENS=250`
- `SNIPER_MIN_INITIAL_LIQUIDITY_SOL=8`
- `SNIPER_MAX_CURVE_PROGRESS_PCT=75`
- `SNIPER_MAX_DEV_WALLET_PCT=15`
- `SNIPER_MAX_TOP_HOLDER_PCT=30`
- `SNIPER_MAX_BUY_BURST_COUNT=36`
- `SNIPER_MIN_UNIQUE_BUYER_RATIO=0.55`
- `SNIPER_MAX_SUSPICIOUS_WALLETS=2`
- `SKIP_PREFLIGHT_ON_VERY_HIGH_PRIORITY=true`

You do not need `DATABASE_SSL` for a normal Neon URI that already includes `sslmode=require`.

## Set Up UptimeRobot

Use UptimeRobot only to keep the free Render services warm.

1. Create an account at `https://uptimerobot.com/pricing`.
2. Create a new `HTTP(s)` monitor.
3. Set the URL to the main service:

```text
https://<your-render-service>.onrender.com/health
```

4. Create another monitor for the sniper service:

```text
https://<your-sniper-render-service>.onrender.com/health
```

5. Leave both intervals at `5 minutes`.
6. Save the monitors.

Important:

- do not point UptimeRobot at `/robots.txt`
- use `/health`

Render explicitly serves `/robots.txt` itself while a free service is spun down, so that path does not wake your app.

## First Deploy Checks

After Render finishes deploying:

1. Open:

```text
GET /health
```

Expected:

```json
{ "ok": true }
```

2. Call:

```text
GET /api/admin/summary
x-api-key: <API_SHARED_SECRET>
```

Expected:

- JSON response
- no database error

3. In Telegram:

- send `/start`
- send `/menu`
- send `/wallet`

4. Watch the Render logs and confirm:

- API started
- Telegram delivery started
- monitor loop is logging metrics
- no repeated out-of-memory restarts

5. Open the sniper service health endpoint:

```text
GET https://<your-sniper-render-service>.onrender.com/health
```

Expected:

```json
{
  "ok": true,
  "service": "sniper"
}
```

Then check the sniper logs for `sniper_ws_open`.

## Limits You Need To Accept

- Render free spins down after 15 minutes with no inbound traffic.
- Render may restart a free service at any time.
- Render free is not for production workloads.
- This bot makes a lot of outbound requests to Neon, Telegram, Helius, Alchemy, Jupiter, and Dexscreener.
- Render says it may suspend a free service that generates unusually high public internet traffic.
- If your RPC provider rate-limits you, you can see `429 Too Many Requests` retries in logs.

Because of those limits, this setup is fine for testing and light personal use, but it is not a stable production trading deployment.

## If Something Fails

### Deploy Fails Immediately

Check:

- `Build Command` is `npm ci && npm run build:render-free`
- main `Start Command` is `npm run start:render-free`
- sniper `Start Command` is `npm run start:sniper-web`
- all required environment variables are present

### Health Check Fails

Check:

- the service is listening on Render's assigned `PORT`
- `DATABASE_URL` is valid
- the build logs do not show migration failure

### Telegram Bot Does Not Respond

Check:

- `TELEGRAM_BOT_TOKEN`
- service logs for Telegram HTTP or webhook errors
- if you see `telegram_http_409`, another machine is still polling the same bot token, or Telegram still has the token in webhook mode from an older deployment
- if you are on Render, confirm `/api/telegram/webhook` is reachable and `/health` is healthy

### Admin Summary Fails

Check:

- request header is `x-api-key`
- value matches `API_SHARED_SECRET`
- migrations completed during startup
