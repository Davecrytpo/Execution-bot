CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS telegram_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_user_id BIGINT NOT NULL UNIQUE,
    chat_id BIGINT NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    auto_buy_enabled BOOLEAN NOT NULL DEFAULT false,
    auto_sell_enabled BOOLEAN NOT NULL DEFAULT true,
    max_buy_sol NUMERIC NOT NULL DEFAULT 0.05,
    daily_limit_sol NUMERIC NOT NULL DEFAULT 0.15,
    min_score NUMERIC NOT NULL DEFAULT 20,
    degen_turbo_enabled BOOLEAN NOT NULL DEFAULT false,
    stop_loss_pct NUMERIC NOT NULL DEFAULT 20,
    take_profit_pct NUMERIC NOT NULL DEFAULT 75,
    slippage_bps INTEGER NOT NULL DEFAULT 500,
    priority_fee_lamports BIGINT NOT NULL DEFAULT 200000,
    withdraw_max_per_tx_sol NUMERIC NOT NULL DEFAULT 0.2,
    withdraw_daily_limit_sol NUMERIC NOT NULL DEFAULT 0.5,
    withdraw_address_cooldown_minutes INTEGER NOT NULL DEFAULT 10,
    last_withdraw_destination TEXT,
    last_withdraw_destination_set_at TIMESTAMPTZ,
    allowed_sources TEXT[] NOT NULL DEFAULT ARRAY['*'],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS custody_wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL UNIQUE,
    encrypted_secret_key TEXT NOT NULL,
    secret_key_iv TEXT NOT NULL,
    secret_key_auth_tag TEXT NOT NULL,
    export_shown_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_state (
    wallet_id UUID PRIMARY KEY REFERENCES custody_wallets(id) ON DELETE CASCADE,
    last_balance_lamports BIGINT NOT NULL DEFAULT 0,
    last_checked_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
    wallet_id UUID NOT NULL REFERENCES custody_wallets(id) ON DELETE CASCADE,
    amount_lamports BIGINT NOT NULL,
    balance_after_lamports BIGINT NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_key TEXT NOT NULL UNIQUE,
    mint TEXT NOT NULL,
    source TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'BUY',
    score NUMERIC,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'RECEIVED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signal_id UUID NOT NULL REFERENCES execution_signals(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
    wallet_id UUID NOT NULL REFERENCES custody_wallets(id) ON DELETE CASCADE,
    mint TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'BUY',
    input_mint TEXT NOT NULL,
    output_mint TEXT NOT NULL,
    amount_lamports BIGINT NOT NULL,
    requested_amount_sol NUMERIC,
    slippage_bps INTEGER NOT NULL DEFAULT 300,
    priority_fee_lamports BIGINT NOT NULL DEFAULT 0,
    quote_response JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    txsig TEXT,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(signal_id, user_id, side),
    UNIQUE(user_id, side, mint, created_at)
);

CREATE TABLE IF NOT EXISTS positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
    wallet_id UUID NOT NULL REFERENCES custody_wallets(id) ON DELETE CASCADE,
    mint TEXT NOT NULL,
    token_amount_raw NUMERIC NOT NULL,
    entry_sol_lamports BIGINT NOT NULL,
    entry_price_in_sol NUMERIC NOT NULL,
    stop_loss_pct NUMERIC NOT NULL DEFAULT 20,
    take_profit_pct NUMERIC NOT NULL DEFAULT 75,
    source TEXT NOT NULL DEFAULT 'unknown',
    status TEXT NOT NULL DEFAULT 'OPEN',
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
    wallet_id UUID NOT NULL REFERENCES custody_wallets(id) ON DELETE CASCADE,
    destination TEXT NOT NULL,
    amount_lamports BIGINT NOT NULL,
    txsig TEXT,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES telegram_users(id) ON DELETE SET NULL,
    chat_id BIGINT,
    action TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signal_replay_guard (
    replay_key TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS manual_trade_idempotency (
    user_id UUID NOT NULL REFERENCES telegram_users(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_telegram_users_enabled ON telegram_users(auto_buy_enabled);
CREATE INDEX IF NOT EXISTS idx_custody_wallets_user_id ON custody_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_execution_signals_source ON execution_signals(source);
CREATE INDEX IF NOT EXISTS idx_execution_orders_status ON execution_orders(status);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_user_id ON positions(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_created ON withdrawal_requests(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs(user_id, created_at);

ALTER TABLE telegram_users ALTER COLUMN daily_limit_sol SET DEFAULT 0.15;
ALTER TABLE telegram_users ALTER COLUMN min_score SET DEFAULT 20;
ALTER TABLE telegram_users ALTER COLUMN slippage_bps SET DEFAULT 500;
ALTER TABLE telegram_users ALTER COLUMN priority_fee_lamports SET DEFAULT 200000;
ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS degen_turbo_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS withdraw_max_per_tx_sol NUMERIC NOT NULL DEFAULT 0.2;
ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS withdraw_daily_limit_sol NUMERIC NOT NULL DEFAULT 0.5;
ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS withdraw_address_cooldown_minutes INTEGER NOT NULL DEFAULT 10;
ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS last_withdraw_destination TEXT;
ALTER TABLE telegram_users ADD COLUMN IF NOT EXISTS last_withdraw_destination_set_at TIMESTAMPTZ;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_positions_user_source_status ON positions(user_id, source, status);
CREATE INDEX IF NOT EXISTS idx_execution_orders_user_mint_created ON execution_orders(user_id, mint, created_at);

CREATE TABLE IF NOT EXISTS sniper_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mint TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'pumpfun',
    creator_wallet TEXT,
    deployer_wallet TEXT,
    bonding_curve TEXT NOT NULL,
    detected_signature TEXT NOT NULL,
    launch_slot BIGINT,
    status TEXT NOT NULL DEFAULT 'DETECTED',
    decision TEXT,
    score NUMERIC,
    price_in_sol NUMERIC,
    market_cap_sol NUMERIC,
    liquidity_sol NUMERIC,
    curve_progress_pct NUMERIC,
    decision_reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sniper_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signature TEXT NOT NULL UNIQUE,
    mint TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_wallet TEXT,
    slot BIGINT,
    sol_amount_lamports BIGINT NOT NULL DEFAULT 0,
    token_amount_raw NUMERIC NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sniper_wallet_reputation (
    wallet TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT 'unknown',
    risk_score NUMERIC NOT NULL DEFAULT 0,
    launches_seen INTEGER NOT NULL DEFAULT 0,
    suspicious_events INTEGER NOT NULL DEFAULT 0,
    rugs_seen INTEGER NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sniper_tokens_status ON sniper_tokens(status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_sniper_events_mint_created ON sniper_events(mint, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sniper_events_actor_created ON sniper_events(actor_wallet, created_at DESC);
