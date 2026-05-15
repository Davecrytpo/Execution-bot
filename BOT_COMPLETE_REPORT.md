# Bot Complete Report

## Project
- Path: `C:\Users\USER\solana-telegram-execution-bot`
- Stack: TypeScript, Node.js, PostgreSQL, Solana Web3, Jupiter API, Telegram Bot API

## Current Product Scope
- Custodial Telegram execution bot for Solana.
- Per-user wallet generation and encrypted custody.
- Signal-driven automated trading with user-level risk controls.
- Manual trade execution, withdrawal queue, deposit detection, and auto-exit logic.
- Professional Telegram UX with menu keyboard and slash commands.

## Security and Custody
- Per-user Solana keypair generation.
- Private key encryption at rest (AES-256-GCM).
- Export key flow requires explicit `/exportkey CONFIRM`.
- Wallet-to-user linkage in DB with active wallet model.
- API protection via shared secret header on `/api/signals` and `/api/admin/*`.

## Database Model
- `telegram_users`
- `custody_wallets`
- `wallet_state`
- `deposits`
- `execution_signals`
- `execution_orders`
- `positions`
- `withdrawal_requests`

## API Surface
- `GET /health` - service health check.
- `POST /api/signals` - authenticated signal ingest for external signal bots.
- `GET /api/admin/summary` - authenticated operational summary.

## Trading Pipeline
- Signal received via API.
- Eligible users matched by:
  - side enablement (auto-buy/auto-sell),
  - source allowlist,
  - min score filter.
- User-specific orders queued in `execution_orders`.
- Worker claims next order (`FOR UPDATE SKIP LOCKED`) and executes Jupiter swap.
- Confirmation/failure stored and pushed to Telegram.
- BUY confirmations create positions.
- SELL confirmations close positions.

## Auto-Exit and Monitoring
- Monitor worker scans open positions.
- Uses quote checks to compute current PnL%.
- Triggers SELL queue when TP/SL threshold is hit.
- Position transitions: `OPEN -> CLOSING -> CLOSED`.
- Deposit scanner records positive balance deltas and notifies users.
- Withdrawal processor claims queued requests and sends on-chain SOL transfers.

## Risk Controls (Standard)
- `max_buy_sol` per user.
- `daily_limit_sol` per user (rolling 24h budget control).
- `min_score` per user.
- `allowed_sources` per user.
- `slippage_bps` per user.
- `priority_fee_lamports` per user.
- Position cap: max 10 open/closing positions per user.
- Minimum buy floor enforced in bot command layer: `0.005 SOL`.

## Degen Defaults and Presets
- System defaults:
  - `min_score = 20`
  - `daily_limit_sol = 0.15`
  - `slippage_bps = 500`
  - `priority_fee_lamports = 200000` (`0.0002 SOL`)
- `/degenmode` preset applies:
  - `min_score = 18`
  - `daily_limit_sol = 0.15`
  - `slippage_bps = 500`
  - `priority_fee_lamports = 200000`
  - `degen_turbo_enabled = true`

## Degen Turbo Safety Guards
- Toggle per user with:
  - `/turboon`
  - `/turbooff`
  - `/turbostatus`
- Turbo checks for BUY signal queueing:
  - Max open positions per source: `3`.
  - Same-token cooldown: `10 minutes`.
  - Duplicate suppression window: `90 seconds`.
- Position `source` is now stored for source-level exposure controls.

## Additional Hardening Added
- Signal API rate limiting (IP + key window control).
- Signal replay protection via request hash guard table.
- Audit log table and audit writes for sensitive bot actions.
- Withdrawal safety controls:
  - per-tx limit,
  - daily withdrawal cap,
  - destination-change cooldown,
  - two-step confirm command (`/confirmwithdraw CODE`).
- Manual trade idempotency table to block accidental duplicate submissions.
- In-memory metrics counters and admin metrics endpoint (`/api/admin/metrics`).
- Worker failure alerting to users on repeated failures in window.
- Replay guard cleanup in monitor loop.

## Testing and Validation
- Unit tests include:
  - signal payload validation,
  - turbo guard decision helper,
  - wizard positive amount validation.
- Smoke dry-run script:
  - `npm run test:smoke`
  - validates config load and core no-chain checks.

## Telegram UX and Command System
- Professional two-column emoji keyboard menu.
- Buttons mapped to internal command handlers.
- `/menu` opens keyboard.
- `/close` hides keyboard.
- Supports both button taps and slash commands.

## Current Telegram Commands
- `/start`
- `/menu`
- `/help`
- `/wallet`
- `/enable`
- `/disable`
- `/enableexit`
- `/disableexit`
- `/settings`
- `/setsize`
- `/setstake`
- `/setdaily`
- `/setminscore`
- `/degenmode`
- `/turboon`
- `/turbooff`
- `/turbostatus`
- `/settp`
- `/setsl`
- `/setslippage`
- `/setpriority`
- `/subscribe`
- `/trade`
- `/buy`
- `/positions`
- `/copytrade`
- `/status`
- `/deposits`
- `/withdraw`
- `/withdrawwizard`
- `/withdrawals`
- `/report`
- `/whytrade`
- `/exportkey CONFIRM`
- `/close`

## Additional User-Facing Features
- `/positions`: open and closing position summary.
- `/copytrade`: copy-trade readiness/source guidance.
- Withdraw Wizard:
  - step 1 destination input,
  - step 2 amount input,
  - validation and queue confirmation.
- `/whytrade`: latest decision transparency including source, score, statuses, and rule summary.

## Workers and Runtime Processes
- API process: `npm run start:api`
- Telegram bot process: `npm run start:bot`
- Executor worker: `npm run start:worker`
- Monitor worker: `npm run start:monitor`

## Configuration
- `PORT`
- `DATABASE_URL`
- `SOLANA_RPC`
- `TELEGRAM_BOT_TOKEN`
- `API_SHARED_SECRET`
- `CUSTODY_MASTER_KEY`
- `JUPITER_BASE_URL`
- `POLL_INTERVAL_MS`
- `MONITOR_INTERVAL_MS`

## Production Notes
- Custodial model means server-side signing authority exists.
- Secure key handling and secret rotation remain critical.
- No guaranteed profits; execution outcome depends on market, latency, and liquidity.
- For existing databases, rerun migration to apply latest schema defaults and new columns.
