# Solana Telegram Execution Bot

Standalone custodial Telegram execution bot for Solana with a realtime pump.fun sniper worker.

What it does:

- Creates a dedicated Solana wallet per Telegram user
- Encrypts the private key at rest with AES-256-GCM
- Shows the private key to the user and tells them to save it
- Accepts trade signals from an external call bot through an HTTP API
- Queues user-specific execution orders in PostgreSQL
- Detects pump.fun launches directly from Helius WebSocket `logsSubscribe`
- Tracks bonding curves with `accountSubscribe`
- Executes swaps on Jupiter with dynamic slippage and priority fee settings
- Races transaction submission across Helius and Alchemy RPCs when needed
- Lets users set stake size, take-profit, stop-loss, slippage, and priority fee
- Supports manual trade entry directly from Telegram
- Tracks positions, deposits, and withdrawal requests
- Monitors open positions for auto-exit conditions
- Queues fast exits on bonding-curve weakness, whale exits, and heavy sell pressure

Important:

- This is a custodial design. The server can sign for user wallets.
- `CUSTODY_MASTER_KEY` must be set before creating any wallet.
- Users must fund their generated wallet address with SOL before enabling auto-buy.
- RPC and API secrets belong in `.env`, not in source files.

Suggested handoff flow:

1. Run `npm install`
2. Copy `.env.example` to `.env`
3. Create the database and run `npm run build && npm run migrate`
4. Start the API, Telegram bot, execution worker, monitor worker, and sniper worker in separate terminals
5. Point the existing degen-call bot to `POST /api/signals` if you still want external signals alongside on-chain sniper signals

Database note:

- Neon is the recommended free Postgres provider for this project.
- A standard Neon connection string with `sslmode=require` works directly as `DATABASE_URL`.
- `npx neonctl@latest init database` is optional. If you already have a Neon connection string, the app can use it immediately.
- `DATABASE_SSL` is only needed when your provider requires explicit SSL configuration outside the connection string.

Free hosting note:

- The cheapest practical hosted setup is `Neon` for the database plus a single `Render` free web service.
- For that setup, use `npm run start:render-free` so migrations run first and then the API, Telegram bot, executor, monitor, and sniper run in one process.
- Use UptimeRobot to ping `/health` every 5 minutes so Render does not idle-spin the service down.
- Do not use `/robots.txt` for wakeups. Render serves that path directly while a free service is spun down.

Realtime sniper flow:

- Helius mainnet websocket is the primary launch detector
- `logsSubscribe` watches the pump.fun program for create, buy, sell, and migrate activity
- `accountSubscribe` tracks each detected token's bonding curve account
- Launch filters evaluate liquidity, curve progress, creator concentration, holder concentration, wallet reputation, and early momentum
- Passing tokens are enqueued through the same order pipeline used by manual and API signals
- Exit signals can be forced by the sniper worker when sell pressure or curve weakness appears

Signal API example:

```http
POST /api/signals
x-api-key: change-me
Content-Type: application/json
```

```json
{
  "signalKey": "pumpfun:token123:buy:1712345678",
  "mint": "TOKEN_MINT_ADDRESS",
  "source": "pumpfun",
  "side": "BUY",
  "score": 78,
  "payload": {
    "symbol": "TOKEN",
    "reason": "fresh launch with passing filters"
  }
}
```

Buy sizing is taken from each Telegram user's settings. Users enable trading with `/enable`, set size with `/setsize 0.05`, and can restrict sources with `/subscribe pumpfun,dexscreener`.

Primary infrastructure envs:

- `DATABASE_URL`
- `DATABASE_SSL` (optional)
- `HELIUS_RPC_URL`
- `HELIUS_WS_URL`
- `HELIUS_GATEKEEPER_RPC_URL`
- `ALCHEMY_RPC_URL`
- `ALCHEMY_WS_URL`
- `JUPITER_API_BASE_URL`
- `JUPITER_API_KEY`
- `DEXSCREENER_BASE_URL`
- `PUMP_PROGRAM_ID`

Latency note:

- Internal queue polling is set to `250ms` for fast pickup.
- Real on-chain execution speed still depends on RPC latency, Jupiter latency, market congestion, and Solana confirmation time.
- The bot is tuned for low latency, but no honest Solana trading system can guarantee a confirmed fill in under one second under all conditions.

Telegram commands:

- `/start`
- `/menu`
- `/help`
- `/wallet`
- `/enable`
- `/disable`
- `/enableexit`
- `/disableexit`
- `/settings`
- `/setsize 0.05`
- `/setstake 0.05`
- `/setdaily 0.25`
- `/setminscore 55`
- `/degenmode`
- `/turboon`
- `/turbooff`
- `/turbostatus`
- `/settp 75`
- `/setsl 20`
- `/setslippage 300`
- `/setpriority 0.0001`
- `/subscribe pumpfun,dexscreener`
- `/trade TOKEN_MINT 0.05 300 75 20`
- `/buy TOKEN_MINT 0.05 300 75 20`
- `/positions`
- `/copytrade`
- `/status`
- `/deposits`
- `/withdraw DESTINATION 0.1`
- `/confirmwithdraw CODE`
- `/withdrawwizard`
- `/withdrawals`
- `/report`
- `/whytrade`
- `/exportkey CONFIRM`
- `/close`

Main menu keyboard:

- Bot now shows a professional two-column emoji button menu in Telegram.
- Button clicks map to command handlers, so both keyboard taps and slash commands work.
- Use `/menu` to reopen it and `/close` to hide it.

How token selection works:

- Signal source must match your subscription list (`allowed_sources`).
- Score must meet your configured threshold (`/setminscore`).
- Auto-buy must be enabled (`/enable`).
- Risk controls must pass: daily limit, max position count, and positive configured buy size.
- If all checks pass, the order is queued and executed by Jupiter routing.
- Use `/whytrade` to see the latest trade decision context for your account.
- Minimum buy amount floor is `0.005 SOL`.
- Degen defaults are now: min score `20`, daily limit `0.15 SOL`, slippage `500 bps`, priority fee `0.0002 SOL`.
- Use `/degenmode` to apply aggressive fast-entry settings per user (`min_score=18`, `daily_limit=0.15`, `slippage=500`, `priority=0.0002`).
- Turbo safeguards can be toggled per user (`/turboon`, `/turbooff`) and include:
  - max open positions per source: `3`
  - token cooldown: `10 minutes`
  - duplicate signal suppression window: `90 seconds`
- `/withdraw` now requires a confirmation code via `/confirmwithdraw CODE`.

Operational docs:

- `BOT_COMPLETE_REPORT.md`
- `DEPLOYMENT_RUNBOOK.md`
- `LEGAL_AND_RISK.md`
- `ENV_VALIDATION_CHECKLIST.md`
- `NEON_DATABASE_GUIDE.md`
- `RENDER_FREE_GUIDE.md`
- `RENDER_DEPLOY_GUIDE.md`
- `render.yaml`

Processes to run:

- `npm run start:api`
- `npm run start:allinone`
- `npm run start:render-free`
- `npm run start:bot`
- `npm run start:worker`
- `npm run start:monitor`
- `npm run start:sniper`

Admin endpoints:

- `GET /api/admin/summary`
- `GET /api/admin/metrics`
- `GET /api/admin/sniper`
