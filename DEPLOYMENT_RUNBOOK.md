# Deployment Runbook

## Preflight
- Verify `.env` values against `.env.example`.
- Prefer Neon for `DATABASE_URL` when you want a free managed Postgres database.
- If your Neon connection string already includes `sslmode=require`, `DATABASE_SSL` is not required.
- Ensure PostgreSQL reachable from app runtime.
- Ensure Helius RPC, Helius WSS, and Alchemy backup RPC values are correct.
- Ensure RPC endpoint is healthy and funded wallets can transact.
- Ensure Telegram bot token is valid.
- Ensure Jupiter API key is valid.

## Database Recommendation
- Prefer Neon as the managed Postgres provider.
- Use the direct Neon connection string in `DATABASE_URL`.
- Keep `sslmode=require` in the connection string.
- If you later swap providers, the app still works with any standard Postgres connection string.

## Startup Order
1. `npm run build`
2. `npm run migrate`
3. Start API: `npm run start:api`
4. Start Telegram bot: `npm run start:bot`
5. Start executor worker: `npm run start:worker`
6. Start monitor worker: `npm run start:monitor`
7. Start sniper worker: `npm run start:sniper`

## Smoke Checks
- `GET /health` returns `{ ok: true }`.
- `GET /api/admin/summary` with API key returns counts.
- `GET /api/admin/metrics` with API key returns metrics object.
- `GET /api/admin/sniper` with API key returns token counts and RPC health.
- `npm run test`
- `npm run test:smoke`

## Rollback
1. Stop all processes.
2. Re-deploy previous build artifact.
3. Revert schema only if migration introduced incompatible data changes.
4. Restart in standard startup order.

## Incident Response
- Repeated order failures:
  - Check RPC status.
  - Check Jupiter API status.
  - Inspect `orders.failed` metric and logs.
- Sniper websocket stalls or no new launches:
  - Check Helius websocket health.
  - Check `/api/admin/sniper` RPC status.
  - Verify heartbeat and reconnect logs from `start:sniper`.
- Signal ingest failures:
  - Check API key headers.
  - Check rate limit or replay rejection metrics.
- Withdrawal failures:
  - Check wallet balance and rent/fees.
  - Check destination validity.

## Secret Rotation
- Rotate `API_SHARED_SECRET`, then update signal producer.
- Rotate `CUSTODY_MASTER_KEY` only with a formal re-encryption migration plan.
- Rotate `TELEGRAM_BOT_TOKEN` in Telegram BotFather and update env.

## Minimum Env
- `DATABASE_URL`
- `DATABASE_SSL` only if your provider requires it outside the URL
- `SOLANA_RPC`
- `HELIUS_RPC_URL`
- `HELIUS_WS_URL`
- `TELEGRAM_BOT_TOKEN`
- `API_SHARED_SECRET`
- `CUSTODY_MASTER_KEY`
- `JUPITER_API_KEY`
