import 'dotenv/config';

function toNumber(value: string | undefined, fallback: number, min?: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || (min !== undefined && parsed < min)) {
    throw new Error(`invalid_numeric_config:${value}`);
  }
  return parsed;
}

function required(name: string, value: string | undefined) {
  if (!value || !value.trim()) {
    throw new Error(`missing_required_env:${name}`);
  }
  return value.trim();
}

function optional(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : '';
}

function toBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`invalid_boolean_config:${value}`);
}

function deriveAlchemyWsUrl(rpcUrl: string) {
  if (!rpcUrl) {
    return '';
  }
  if (rpcUrl.startsWith('wss://')) {
    return rpcUrl;
  }
  if (rpcUrl.startsWith('https://')) {
    return `wss://${rpcUrl.slice('https://'.length)}`;
  }
  if (rpcUrl.startsWith('http://')) {
    return `ws://${rpcUrl.slice('http://'.length)}`;
  }
  return '';
}

export const config = {
  port: toNumber(process.env.PORT, 3100, 1),
  databaseUrl: required('DATABASE_URL', process.env.DATABASE_URL),
  solanaRpc: required('SOLANA_RPC', process.env.SOLANA_RPC ?? process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com'),
  heliusRpcUrl: required('HELIUS_RPC_URL', process.env.HELIUS_RPC_URL ?? process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com'),
  heliusWsUrl: optional(process.env.HELIUS_WS_URL),
  heliusGatekeeperRpcUrl: optional(process.env.HELIUS_GATEKEEPER_RPC_URL),
  alchemyRpcUrl: optional(process.env.ALCHEMY_RPC_URL),
  alchemyWsUrl: optional(process.env.ALCHEMY_WS_URL) || deriveAlchemyWsUrl(optional(process.env.ALCHEMY_RPC_URL)),
  telegramBotToken: required('TELEGRAM_BOT_TOKEN', process.env.TELEGRAM_BOT_TOKEN),
  apiSharedSecret: required('API_SHARED_SECRET', process.env.API_SHARED_SECRET),
  custodyMasterKey: required('CUSTODY_MASTER_KEY', process.env.CUSTODY_MASTER_KEY),
  jupiterApiBaseUrl: process.env.JUPITER_API_BASE_URL?.trim() ?? process.env.JUPITER_BASE_URL?.trim() ?? 'https://api.jup.ag/swap/v1',
  jupiterApiKey: optional(process.env.JUPITER_API_KEY),
  dexscreenerBaseUrl: process.env.DEXSCREENER_BASE_URL?.trim() ?? 'https://api.dexscreener.com/latest/dex/tokens',
  pumpProgramId: process.env.PUMP_PROGRAM_ID?.trim() ?? '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pollIntervalMs: toNumber(process.env.POLL_INTERVAL_MS, 250, 50),
  monitorIntervalMs: toNumber(process.env.MONITOR_INTERVAL_MS, 30000, 1000),
  signalRateLimitWindowMs: toNumber(process.env.SIGNAL_RATE_LIMIT_WINDOW_MS, 60000, 1000),
  signalRateLimitMax: toNumber(process.env.SIGNAL_RATE_LIMIT_MAX, 120, 1),
  signalReplayWindowSeconds: toNumber(process.env.SIGNAL_REPLAY_WINDOW_SECONDS, 300, 30),
  workerFailureAlertThreshold: toNumber(process.env.WORKER_FAILURE_ALERT_THRESHOLD, 3, 1),
  workerFailureAlertWindowMs: toNumber(process.env.WORKER_FAILURE_ALERT_WINDOW_MS, 300000, 10000),
  rpcSlotLagThreshold: toNumber(process.env.RPC_SLOT_LAG_THRESHOLD, 15, 1),
  rpcHealthCacheMs: toNumber(process.env.RPC_HEALTH_CACHE_MS, 5000, 250),
  rpcRequestTimeoutMs: toNumber(process.env.RPC_REQUEST_TIMEOUT_MS, 10000, 1000),
  rpcEndpointCooldownMs: toNumber(process.env.RPC_ENDPOINT_COOLDOWN_MS, 30000, 1000),
  rpcErrorLogCooldownMs: toNumber(process.env.RPC_ERROR_LOG_COOLDOWN_MS, 15000, 1000),
  txConfirmationTimeoutMs: toNumber(process.env.TX_CONFIRMATION_TIMEOUT_MS, 60000, 5000),
  wsHeartbeatMs: toNumber(process.env.WS_HEARTBEAT_MS, 30000, 1000),
  wsFreezeThresholdMs: toNumber(process.env.WS_FREEZE_THRESHOLD_MS, 90000, 5000),
  wsReconnectBaseMs: toNumber(process.env.WS_RECONNECT_BASE_MS, 2000, 250),
  wsReconnectMaxMs: toNumber(process.env.WS_RECONNECT_MAX_MS, 15000, 1000),
  sniperEnableDexScreener: toBoolean(process.env.SNIPER_ENABLE_DEXSCREENER, true),
  sniperWarmupMs: toNumber(process.env.SNIPER_WARMUP_MS, 4000, 0),
  sniperMomentumWindowMs: toNumber(process.env.SNIPER_MOMENTUM_WINDOW_MS, 10000, 1000),
  sniperProcessedSignatureTtlMs: toNumber(process.env.SNIPER_PROCESSED_SIGNATURE_TTL_MS, 1800000, 10000),
  sniperMaxTrackedTokens: toNumber(process.env.SNIPER_MAX_TRACKED_TOKENS, 250, 10),
  sniperMinInitialLiquiditySol: toNumber(process.env.SNIPER_MIN_INITIAL_LIQUIDITY_SOL, 8, 0),
  sniperMaxCurveProgressPct: toNumber(process.env.SNIPER_MAX_CURVE_PROGRESS_PCT, 75, 0),
  sniperMaxDevWalletPct: toNumber(process.env.SNIPER_MAX_DEV_WALLET_PCT, 15, 0),
  sniperMaxTopHolderPct: toNumber(process.env.SNIPER_MAX_TOP_HOLDER_PCT, 30, 0),
  sniperMaxBuyBurstCount: toNumber(process.env.SNIPER_MAX_BUY_BURST_COUNT, 36, 1),
  sniperMinUniqueBuyerRatio: toNumber(process.env.SNIPER_MIN_UNIQUE_BUYER_RATIO, 0.55, 0),
  sniperMaxSuspiciousWallets: toNumber(process.env.SNIPER_MAX_SUSPICIOUS_WALLETS, 2, 0),
  skipPreflightOnVeryHighPriority: toBoolean(process.env.SKIP_PREFLIGHT_ON_VERY_HIGH_PRIORITY, true),
  enableTelegramBot: toBoolean(process.env.ENABLE_TELEGRAM_BOT, true),
  enableExecutorWorker: toBoolean(process.env.ENABLE_EXECUTOR_WORKER, true),
  enableMonitorWorker: toBoolean(process.env.ENABLE_MONITOR_WORKER, true),
  enableSniperWorker: toBoolean(process.env.ENABLE_SNIPER_WORKER, true),
  enableMetricsSnapshotLogs: toBoolean(process.env.ENABLE_METRICS_SNAPSHOT_LOGS, true)
};
