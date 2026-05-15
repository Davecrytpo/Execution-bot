# Deployment Runbook

## Preflight
- Verify `.env` values against `.env.example`.
- Use Render Postgres for `DATABASE_URL`.
- Set `DATABASE_SSL=true` for Render Postgres connections.
- Ensure PostgreSQL reachable from app runtime.
- Ensure Helius RPC, Helius WSS, and Alchemy backup RPC values are correct.
- Ensure RPC endpoint is healthy and funded wallets can transact.
- Ensure Telegram bot token is valid.
- Ensure Jupiter API key is valid.

## Render Recommendation
- Prefer the included `render.yaml` Blueprint.
- The Blueprint provisions one Render Postgres database plus:
  - one web service for the API
  - four background workers for bot, executor, monitor, and sniper
- The API service runs `npm run migrate` as the pre-deploy command.
- Keep all services and the database in the same Render region.

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

## Render Env Minimum
- `DATABASE_URL` from the Render Postgres connection string
- `DATABASE_SSL=true`
- `SOLANA_RPC`
- `HELIUS_RPC_URL`
- `HELIUS_WS_URL`
- `TELEGRAM_BOT_TOKEN`
- `API_SHARED_SECRET`
- `CUSTODY_MASTER_KEY`
- `JUPITER_API_KEY`
