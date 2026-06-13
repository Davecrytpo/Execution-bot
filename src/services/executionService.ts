import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction
} from '@solana/web3.js';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { config } from '../config.js';
import { deriveBondingCurveAddress } from '../sniper/pumpFun.js';
import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { sendMessage } from '../lib/telegram.js';
import { incMetric } from '../lib/metrics.js';
import { rpcPool } from '../lib/rpcPool.js';
import {
  decodeWalletSecret,
  getWalletBalanceLamports,
  getUserWithWallet,
  type WalletRecord
} from './custodyService.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;
const MIN_TRADE_SLIPPAGE_BPS = 2_000;
const MAX_TRADE_SLIPPAGE_BPS = 5_000;
const MIN_PRIORITY_FEE_LAMPORTS = 1_000_000;
const MAX_PRIORITY_FEE_LAMPORTS = 5_000_000;
const MAX_ORDER_ATTEMPTS = 3;
const TURBO_MAX_OPEN_POSITIONS_PER_SOURCE = 3;
const TURBO_TOKEN_COOLDOWN_MINUTES = 10;
const TURBO_DUPLICATE_WINDOW_SECONDS = 90;
const failureState = new Map<string, number[]>();
const DASHBOARD_REPLY_MARKUP = {
  inline_keyboard: [
    [
      { text: 'Menu', callback_data: 'view:home' },
      { text: 'Trading', callback_data: 'view:trading' }
    ],
    [
      { text: 'Wallet', callback_data: 'view:wallet' },
      { text: 'Positions', callback_data: 'view:analytics_positions' }
    ]
  ]
};
type OrderMetadata = Record<string, unknown>;

type OrderRow = {
  id: string;
  mint: string;
  side: string;
  input_mint: string;
  output_mint: string;
  amount_lamports: string;
  slippage_bps: number;
  priority_fee_lamports: string;
  metadata: OrderMetadata;
  wallet_id: string;
  user_id: string;
  chat_id: string;
  public_key: string;
  encrypted_secret_key: string;
  secret_key_iv: string;
  secret_key_auth_tag: string;
};

type WithdrawalRow = {
  id: string;
  destination: string;
  amount_lamports: string;
  chat_id: string;
  wallet_id: string;
  user_id: string;
  public_key: string;
  encrypted_secret_key: string;
  secret_key_iv: string;
  secret_key_auth_tag: string;
};

function maybeNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function humanizeExecutionError(error: unknown) {
  return String(error instanceof Error ? error.message : error ?? 'unknown_error')
    .replace(/[_`*[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function httpErrorMessage(prefix: string, response: Response) {
  const body = await response.text().catch(() => '');
  const detail = body.trim().replace(/\s+/g, ' ').slice(0, 160);
  return detail ? `${prefix}_${response.status}:${detail}` : `${prefix}_${response.status}`;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function resolveAttemptSlippage(baseSlippageBps: number, attempt: number) {
  const safeBase = clampNumber(baseSlippageBps || MIN_TRADE_SLIPPAGE_BPS, MIN_TRADE_SLIPPAGE_BPS, MAX_TRADE_SLIPPAGE_BPS);
  return clampNumber(safeBase + ((attempt - 1) * 1_500), MIN_TRADE_SLIPPAGE_BPS, MAX_TRADE_SLIPPAGE_BPS);
}

function resolveAttemptPriority(basePriorityFeeLamports: number, attempt: number) {
  const safeBase = clampNumber(
    basePriorityFeeLamports || MIN_PRIORITY_FEE_LAMPORTS,
    MIN_PRIORITY_FEE_LAMPORTS,
    MAX_PRIORITY_FEE_LAMPORTS
  );
  return clampNumber(safeBase + ((attempt - 1) * 1_000_000), MIN_PRIORITY_FEE_LAMPORTS, MAX_PRIORITY_FEE_LAMPORTS);
}

export function isRetryableOrderError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error ?? '').toLowerCase();
  return message.includes('quote_failed_5')
    || message.includes('swap_failed_5')
    || message.includes('swap_transaction_missing')
    || message.includes('fetch failed')
    || message.includes('timeout:')
    || message.includes('econnreset')
    || message.includes('etimedout')
    || message.includes('socket')
    || message.includes('network')
    || message.includes('rpc_send_failed')
    || message.includes('blockhashnotfound')
    || message.includes('slippage');
}

export function isTokenNotTradableError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error ?? '').toLowerCase();
  return message.includes('token_not_tradable') || message.includes('not tradable');
}

function isConfirmationUncertain(error: unknown) {
  const message = String(error instanceof Error ? error.message : error ?? '').toLowerCase();
  return message.includes('confirmtransaction')
    || message.includes('confirmation')
    || message.includes('timeout:')
    || message.includes('rpc_all_failed');
}

function composeOrderCompletionNotice(params: {
  confirmationWasUncertain: boolean;
  tokenNotTradable: boolean;
  mint: string;
  finalMessage: string;
  attemptsUsed: number;
}) {
  const attempts = params.attemptsUsed || 1;
  if (params.confirmationWasUncertain) {
    return [
      '⚠️ *Trade confirmation pending*',
      `Token: \`${params.mint.slice(0, 8)}...${params.mint.slice(-6)}\``,
      'A transaction was submitted, but confirmation is still pending.',
      `Status: ${humanizeExecutionError(params.finalMessage)}`
    ];
  }

  if (params.tokenNotTradable) {
    return [
      '⏭️ *Trade skipped*',
      `Token: \`${params.mint.slice(0, 8)}...${params.mint.slice(-6)}\``,
      'Reason: Jupiter route is not available for this token yet.',
      'No SOL was spent.'
    ];
  }

  return [
    '❌ *Trade failed*',
    `Token: \`${params.mint.slice(0, 8)}...${params.mint.slice(-6)}\``,
    `Reason: ${humanizeExecutionError(params.finalMessage)}`,
    `Tried: \`${attempts} attempt${attempts === 1 ? '' : 's'}\``
  ];
}

function getJupiterHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {})
  };
}

function resolveSignalMetadata(payload?: Record<string, unknown>) {
  const recommendedSlippageBps = maybeNumber(payload?.recommendedSlippageBps);
  const recommendedPriorityFeeLamports = maybeNumber(payload?.recommendedPriorityFeeLamports);
  const priorityLevelValue = String(payload?.priorityLevel ?? '').trim();
  const priorityLevel = priorityLevelValue === 'veryHigh'
    ? 'veryHigh'
    : priorityLevelValue === 'high'
      ? 'high'
      : 'medium';

  return {
    recommendedSlippageBps,
    recommendedPriorityFeeLamports,
    priorityLevel
  } as const;
}

function resolvePrioritySettings(metadata: OrderMetadata, maxLamports: number) {
  const priorityLevelValue = String(metadata.priorityLevel ?? '').trim();
  const priorityLevel = priorityLevelValue === 'veryHigh'
    ? 'veryHigh'
    : priorityLevelValue === 'high'
      ? 'high'
      : 'medium';

  return {
    priorityLevel,
    maxLamports: Math.max(MIN_PRIORITY_FEE_LAMPORTS, maxLamports)
  };
}

function shouldSkipPreflight(metadata: OrderMetadata) {
  return config.skipPreflightOnVeryHighPriority && String(metadata.priorityLevel ?? '') === 'veryHigh';
}

export async function enqueueSignal(body: {
  signalKey?: string;
  mint: string;
  source: string;
  side?: string;
  score?: number | null;
  amountLamports?: number;
  inputMint?: string;
  outputMint?: string;
  payload?: Record<string, unknown>;
}) {
  validateSignalPayload(body);
  const side = String(body.side ?? 'BUY').toUpperCase();
  const signalKey = body.signalKey ?? `${body.source}:${body.mint}:${side}:${Date.now()}`;
  const inputMint = body.inputMint ?? (side === 'BUY' ? SOL_MINT : body.mint);
  const outputMint = body.outputMint ?? (side === 'BUY' ? body.mint : SOL_MINT);
  const signalMetadata = resolveSignalMetadata(body.payload);

  const signalResult = await query<{ id: string }>(
    `
    INSERT INTO execution_signals (signal_key, mint, source, side, score, payload)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (signal_key) DO UPDATE
    SET updated_at = NOW()
    RETURNING id
    `,
    [signalKey, body.mint, body.source, side, body.score ?? null, body.payload ?? {}]
  );

  const signalId = signalResult.rows[0].id;
  const eligibleUsers = await query<{
    id: string;
    auto_buy_enabled: boolean;
    auto_sell_enabled: boolean;
    max_buy_sol: string;
    stop_loss_pct: string;
    take_profit_pct: string;
    slippage_bps: number;
    priority_fee_lamports: string;
    allowed_sources: string[];
    min_score: string;
    degen_turbo_enabled: boolean;
    wallet_id: string;
  }>(
    `
    SELECT
      tu.id,
      tu.auto_buy_enabled,
      tu.auto_sell_enabled,
      tu.max_buy_sol,
      tu.stop_loss_pct,
      tu.take_profit_pct,
      tu.slippage_bps,
      tu.priority_fee_lamports,
      tu.allowed_sources,
      tu.min_score,
      tu.degen_turbo_enabled,
      cw.id AS wallet_id
    FROM telegram_users tu
    JOIN custody_wallets cw ON cw.user_id = tu.id AND cw.is_active = true
    WHERE (
      ($1 = 'BUY' AND tu.auto_buy_enabled = true)
      OR ($1 = 'SELL' AND tu.auto_sell_enabled = true)
    )
    AND (
      '*' = ANY(tu.allowed_sources)
      OR $2 = ANY(tu.allowed_sources)
    )
    AND ($3::numeric IS NULL OR tu.min_score <= $3::numeric)
    `,
    [side, body.source, body.score ?? null]
  );
  logger.info('signal_eligible_users', {
    signalId,
    signalKey,
    mint: body.mint,
    source: body.source,
    side,
    score: body.score ?? null,
    eligibleUsers: eligibleUsers.rowCount
  });

  let queued = 0;
  for (const user of eligibleUsers.rows) {
    const amountLamports = side === 'BUY'
      ? Math.floor(Number(user.max_buy_sol) * 1_000_000_000)
      : Number(body.amountLamports ?? 0);
    const slippageBps = Math.max(
      Number(user.slippage_bps),
      signalMetadata.recommendedSlippageBps ?? Number(user.slippage_bps)
    );
    const priorityFeeLamports = Math.max(
      Number(user.priority_fee_lamports),
      signalMetadata.recommendedPriorityFeeLamports ?? Number(user.priority_fee_lamports)
    );

    if (amountLamports <= 0) {
      logger.info('signal_user_skipped', {
        signalId,
        userId: user.id,
        reason: 'non_positive_amount'
      });
      continue;
    }

    if (side === 'BUY' && !(await canUserOpenNewTrade(user.id, amountLamports))) {
      logger.info('signal_user_skipped', {
        signalId,
        userId: user.id,
        reason: 'daily_limit_or_position_limit_reached'
      });
      continue;
    }

    if (
      side === 'BUY'
      && user.degen_turbo_enabled
      && !(await passesDegenTurboChecks(user.id, body.source, body.mint))
    ) {
      logger.info('signal_user_skipped', {
        signalId,
        userId: user.id,
        reason: 'degen_turbo_checks_failed'
      });
      continue;
    }

    const inserted = await query<{ id: string }>(
      `
      INSERT INTO execution_orders (
        signal_id, user_id, wallet_id, mint, side, input_mint, output_mint, amount_lamports, requested_amount_sol, metadata
      , slippage_bps, priority_fee_lamports
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (signal_id, user_id, side) DO NOTHING
      RETURNING id
      `,
      [
        signalId,
        user.id,
        user.wallet_id,
        body.mint,
        side,
        inputMint,
        outputMint,
        amountLamports,
        side === 'BUY' ? Number(user.max_buy_sol) : null,
        {
          ...(body.payload ?? {}),
          signalSource: body.source,
          priorityLevel: signalMetadata.priorityLevel,
          turboEnabled: Boolean(user.degen_turbo_enabled),
          stopLossPct: Number(user.stop_loss_pct),
          takeProfitPct: Number(user.take_profit_pct)
        },
        slippageBps,
        priorityFeeLamports
      ]
    );

    if (inserted.rows[0]?.id) {
      queued += 1;
    }
  }

  await query(
    'UPDATE execution_signals SET status = $1, updated_at = NOW() WHERE id = $2',
    [queued > 0 ? 'QUEUED' : 'NO_MATCH', signalId]
  );
  logger.info('signal_enqueue_result', {
    signalId,
    signalKey,
    mint: body.mint,
    source: body.source,
    side,
    queued
  });

  return { signalId, signalKey, queued };
}

export function validateSignalPayload(body: {
  mint?: string;
  source?: string;
  side?: string;
  score?: number | null;
}) {
  if (!body.mint || !body.source) {
    throw new Error('mint_and_source_required');
  }
  const side = String(body.side ?? 'BUY').toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) {
    throw new Error('invalid_side');
  }
  if (body.score !== undefined && body.score !== null && !Number.isFinite(Number(body.score))) {
    throw new Error('invalid_score');
  }
}

async function canUserOpenNewTrade(userId: string, amountLamports: number) {
  const stats = await query<{
    daily_limit_sol: string;
    spent_today_lamports: string;
    open_positions: string;
  }>(
    `
    SELECT
      tu.daily_limit_sol,
      COALESCE((
        SELECT SUM(entry_sol_lamports)::text
        FROM positions
        WHERE user_id = tu.id
          AND opened_at > NOW() - INTERVAL '24 hours'
      ), '0') AS spent_today_lamports,
      COALESCE((
        SELECT COUNT(*)::text
        FROM positions
        WHERE user_id = tu.id
          AND status IN ('OPEN', 'CLOSING')
      ), '0') AS open_positions
    FROM telegram_users tu
    WHERE tu.id = $1
    `,
    [userId]
  );

  const row = stats.rows[0];
  if (!row) {
    return false;
  }

  const dailyLimitLamports = Math.floor(Number(row.daily_limit_sol) * LAMPORTS_PER_SOL);
  const spentTodayLamports = Number(row.spent_today_lamports);
  const openPositions = Number(row.open_positions);

  // [Fix] Increased position limit for sniper activity
  if (openPositions >= 50) {
    return false;
  }

  return spentTodayLamports + amountLamports <= dailyLimitLamports;
}

async function getBestQuote(inputMint: string, outputMint: string, amountLamports: number, slippageBps: number) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amountLamports),
    slippageBps: String(slippageBps)
  });

  const response = await fetch(`${config.jupiterApiBaseUrl}/quote?${params.toString()}`, {
    headers: config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {}
  });
  if (!response.ok) {
    throw new Error(await httpErrorMessage('quote_failed', response));
  }

  const data = await response.json() as any;
  if (!data?.outAmount) {
    throw new Error('quote_missing');
  }

  return data;
}

async function passesDegenTurboChecks(userId: string, source: string, mint: string) {
  const checks = await query<{
    open_by_source: string;
    recent_duplicate_orders: string;
    recent_same_mint_orders: string;
  }>(
    `
    SELECT
      COALESCE((
        SELECT COUNT(*)::text
        FROM positions p
        WHERE p.user_id = $1
          AND p.source = $2
          AND p.status IN ('OPEN', 'CLOSING')
      ), '0') AS open_by_source,
      COALESCE((
        SELECT COUNT(*)::text
        FROM execution_orders eo
        WHERE eo.user_id = $1
          AND eo.side = 'BUY'
          AND eo.mint = $3
          AND eo.created_at > NOW() - ($4::text || ' seconds')::interval
      ), '0') AS recent_duplicate_orders,
      COALESCE((
        SELECT COUNT(*)::text
        FROM execution_orders eo
        WHERE eo.user_id = $1
          AND eo.side = 'BUY'
          AND eo.mint = $3
          AND eo.created_at > NOW() - ($5::text || ' minutes')::interval
      ), '0') AS recent_same_mint_orders
    `,
    [userId, source, mint, TURBO_DUPLICATE_WINDOW_SECONDS, TURBO_TOKEN_COOLDOWN_MINUTES]
  );

  const row = checks.rows[0];
  if (!row) {
    return false;
  }

  const openBySource = Number(row.open_by_source);
  const recentDuplicates = Number(row.recent_duplicate_orders);
  const recentSameMint = Number(row.recent_same_mint_orders);

  if (openBySource >= TURBO_MAX_OPEN_POSITIONS_PER_SOURCE) {
    return false;
  }

  if (recentDuplicates > 0) {
    return false;
  }

  return recentSameMint === 0;
}

export function evaluateTurboGuardRow(row: {
  open_by_source: string;
  recent_duplicate_orders: string;
  recent_same_mint_orders: string;
}) {
  const openBySource = Number(row.open_by_source);
  const recentDuplicates = Number(row.recent_duplicate_orders);
  const recentSameMint = Number(row.recent_same_mint_orders);
  if (openBySource >= TURBO_MAX_OPEN_POSITIONS_PER_SOURCE) {
    return false;
  }
  if (recentDuplicates > 0) {
    return false;
  }
  return recentSameMint === 0;
}

function registerFailure(identity: string) {
  const now = Date.now();
  const windowMs = config.workerFailureAlertWindowMs;
  const threshold = config.workerFailureAlertThreshold;
  const items = (failureState.get(identity) ?? []).filter((ts) => now - ts <= windowMs);
  items.push(now);
  failureState.set(identity, items);
  return items.length >= threshold;
}

async function buildSwapTransaction(quoteResponse: unknown, userPublicKey: string, priorityFeeLamports: number) {
  const response = await fetch(`${config.jupiterApiBaseUrl}/swap`, {
    method: 'POST',
    headers: getJupiterHeaders(),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: 'medium',
          maxLamports: Math.max(MIN_PRIORITY_FEE_LAMPORTS, priorityFeeLamports)
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(await httpErrorMessage('swap_failed', response));
  }

  const data = await response.json() as { swapTransaction?: string };
  if (!data.swapTransaction) {
    throw new Error('swap_transaction_missing');
  }

  return data.swapTransaction;
}

async function buildSwapTransactionForOrder(
  order: OrderRow,
  quoteResponse: unknown,
  userPublicKey: string,
  priorityFeeLamports?: number
) {
  const priority = resolvePrioritySettings(order.metadata, priorityFeeLamports ?? Number(order.priority_fee_lamports ?? 0));
  const response = await fetch(`${config.jupiterApiBaseUrl}/swap`, {
    method: 'POST',
    headers: getJupiterHeaders(),
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: priority.priorityLevel,
          maxLamports: priority.maxLamports
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(await httpErrorMessage('swap_failed', response));
  }

  const data = await response.json() as {
    swapTransaction?: string;
    prioritizationFeeLamports?: number;
    dynamicSlippageReport?: { slippageBps?: number };
  };

  if (!data.swapTransaction) {
    throw new Error('swap_transaction_missing');
  }

  return data;
}

async function claimNextOrder(): Promise<OrderRow | null> {
  const result = await query<OrderRow>(
    `
    WITH next_order AS (
      SELECT eo.id
      FROM execution_orders eo
      WHERE eo.status = 'QUEUED'
        OR (
          eo.status = 'PROCESSING'
          AND eo.txsig IS NULL
          AND eo.updated_at < NOW() - INTERVAL '2 minutes'
        )
      ORDER BY eo.created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE execution_orders eo
    SET status = 'PROCESSING', updated_at = NOW()
    FROM next_order
    WHERE eo.id = next_order.id
    RETURNING
      eo.*,
      (SELECT tu.chat_id FROM telegram_users tu WHERE tu.id = eo.user_id) AS chat_id,
      (SELECT cw.public_key FROM custody_wallets cw WHERE cw.id = eo.wallet_id) AS public_key,
      (SELECT cw.encrypted_secret_key FROM custody_wallets cw WHERE cw.id = eo.wallet_id) AS encrypted_secret_key,
      (SELECT cw.secret_key_iv FROM custody_wallets cw WHERE cw.id = eo.wallet_id) AS secret_key_iv,
      (SELECT cw.secret_key_auth_tag FROM custody_wallets cw WHERE cw.id = eo.wallet_id) AS secret_key_auth_tag
    `
  );

  return result.rows[0] ?? null;
}

async function buildWalletRecord(row: {
  wallet_id: string;
  user_id: string;
  public_key: string;
  encrypted_secret_key: string;
  secret_key_iv: string;
  secret_key_auth_tag: string;
}): Promise<WalletRecord> {
  return {
    id: row.wallet_id,
    user_id: row.user_id,
    public_key: row.public_key,
    encrypted_secret_key: row.encrypted_secret_key,
    secret_key_iv: row.secret_key_iv,
    secret_key_auth_tag: row.secret_key_auth_tag,
    export_shown_at: null
  };
}

async function upsertPositionFromBuy(order: OrderRow, quote: any) {
  const rawTokenAmount = Number(quote.outAmount ?? 0);
  if (rawTokenAmount <= 0) {
    return;
  }

  const priceInSol = Number(order.amount_lamports) / rawTokenAmount;
  await query(
    `
    INSERT INTO positions (user_id, wallet_id, mint, token_amount_raw, entry_sol_lamports, entry_price_in_sol, stop_loss_pct, take_profit_pct, source)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      order.user_id,
      order.wallet_id,
      order.mint,
      rawTokenAmount,
      Number(order.amount_lamports),
      priceInSol,
      Number(order.metadata.stopLossPct ?? 20),
      Number(order.metadata.takeProfitPct ?? 75),
      String(order.metadata.signalSource ?? 'unknown')
    ]
  );
}

async function closePositionFromSell(order: OrderRow) {
  await query(
    `
    UPDATE positions
    SET status = 'CLOSED', updated_at = NOW(), closed_at = NOW()
    WHERE id = (
      SELECT id
      FROM positions
      WHERE user_id = $1 AND mint = $2 AND status IN ('OPEN', 'CLOSING')
      ORDER BY opened_at
      LIMIT 1
    )
    `,
    [order.user_id, order.mint]
  );
}

function isPumpToken(mint: string) {
  return mint.toLowerCase().endsWith('pump');
}

async function processPumpTrade(order: OrderRow, signer: Keypair) {
  const connection = rpcPool.getPrimaryConnection();
  const provider = new AnchorProvider(connection, new Wallet(signer), { commitment: 'confirmed' });
  const sdk = new PumpFunSDK(provider);
  const mint = new PublicKey(order.mint);
  const slippageBps = BigInt(order.slippage_bps || 300);
  const priorityFeeLamports = Number(order.priority_fee_lamports || 1_000_000);

  const options = {
    unitLimit: 250_000,
    unitPrice: Math.floor((priorityFeeLamports / 250_000) * 1_000_000),
  };

  if (order.side === 'BUY') {
    return await sdk.buy(signer, mint, BigInt(order.amount_lamports), slippageBps, options);
  } else {
    // [Fix B] Check if bonding curve exists before selling via Pump SDK
    const bondingCurve = deriveBondingCurveAddress(order.mint, config.pumpProgramId);
    const acc = await rpcPool.withConnection(
      (connection) => connection.getAccountInfo(new PublicKey(bondingCurve), 'confirmed')
    );
    if (!acc) {
      logger.info('pump_bonding_curve_not_found_on_sell_assuming_migrated', { mint: order.mint });
      throw new Error('pump_migrated_to_raydium');
    }
    return await sdk.sell(signer, mint, BigInt(order.amount_lamports), slippageBps, options);
  }
}

export async function processNextOrder() {
  const order = await claimNextOrder();
  if (!order) {
    return false;
  }

  let lastError: unknown = null;
  let lastSignature: string | null = null;
  let confirmationWasUncertain = false;
  let attemptsUsed = 0;

  try {
    incMetric('orders.processing');
    const walletRecord = await buildWalletRecord(order);
    const secret = decodeWalletSecret(walletRecord);
    const signer = Keypair.fromSecretKey(secret);
    let usePumpSdk = isPumpToken(order.mint);

    for (let attempt = 1; attempt <= MAX_ORDER_ATTEMPTS; attempt += 1) {
      attemptsUsed = attempt;
      const attemptSlippageBps = resolveAttemptSlippage(Number(order.slippage_bps ?? 0), attempt);
      const attemptPriorityFeeLamports = resolveAttemptPriority(Number(order.priority_fee_lamports ?? 0), attempt);

      try {
        let signature: string | undefined;
        let quote: any;
        let swapResponse: any = {};

        if (usePumpSdk) {
          logger.info('executing_pump_trade', { mint: order.mint, side: order.side, attempt });
          try {
            const pumpResult = await processPumpTrade({
              ...order,
              slippage_bps: attemptSlippageBps,
              priority_fee_lamports: String(attemptPriorityFeeLamports)
            }, signer);
            
            if (!pumpResult.success) {
              throw new Error(pumpResult.error ? JSON.stringify(pumpResult.error) : 'pump_trade_failed');
            }
            signature = pumpResult.signature;
            if (!signature) {
              throw new Error('pump_trade_no_signature');
            }
            quote = { outAmount: '0' }; // Will be updated after confirmation
            swapResponse = {
              dynamicSlippageReport: { slippageBps: attemptSlippageBps }
            };
          } catch (pumpError: any) {
            if (pumpError.message === 'pump_migrated_to_raydium') {
              logger.info('pump_migrated_to_raydium_detected_switching_to_jupiter', { mint: order.mint });
              usePumpSdk = false;
              // Fallback to Jupiter immediately in the same attempt
              quote = await getBestQuote(
                order.input_mint,
                order.output_mint,
                Number(order.amount_lamports),
                attemptSlippageBps
              );
              swapResponse = await buildSwapTransactionForOrder(
                order,
                quote,
                signer.publicKey.toBase58(),
                attemptPriorityFeeLamports
              );
              const tx = VersionedTransaction.deserialize(Buffer.from(swapResponse.swapTransaction!, 'base64'));
              tx.sign([signer]);

              const sendResult = await rpcPool.sendRawTransactionRace(tx.serialize(), {
                skipPreflight: shouldSkipPreflight(order.metadata),
                preflightCommitment: 'processed'
              });
              signature = sendResult.signature;
            } else {
              throw pumpError;
            }
          }
        } else {
          quote = await getBestQuote(
            order.input_mint,
            order.output_mint,
            Number(order.amount_lamports),
            attemptSlippageBps
          );
          swapResponse = await buildSwapTransactionForOrder(
            order,
            quote,
            signer.publicKey.toBase58(),
            attemptPriorityFeeLamports
          );
          const tx = VersionedTransaction.deserialize(Buffer.from(swapResponse.swapTransaction!, 'base64'));
          tx.sign([signer]);

          const sendResult = await rpcPool.sendRawTransactionRace(tx.serialize(), {
            skipPreflight: shouldSkipPreflight(order.metadata),
            preflightCommitment: 'processed'
          });
          signature = sendResult.signature;
        }

        lastSignature = signature;

        await query(
          `
          UPDATE execution_orders
          SET txsig = $2, updated_at = NOW()
          WHERE id = $1
          `,
          [order.id, signature]
        );

        let confirmation;
        try {
          confirmation = await rpcPool.confirmSignature(signature, 'confirmed');
        } catch (error) {
          confirmationWasUncertain = isConfirmationUncertain(error);
          throw error;
        }

        if (confirmation.value.err) {
          throw new Error(JSON.stringify(confirmation.value.err));
        }

        if (isPumpToken(order.mint) && order.side === 'BUY') {
          // Fetch token balance change for accurate tracking
          try {
            const tokenAccounts = await rpcPool.withConnection(
              (connection) => connection.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(order.mint) })
            );
            quote.outAmount = tokenAccounts.value[0]?.account.data.parsed.info.tokenAmount.amount || '0';
          } catch (e) {
            logger.error('failed_to_fetch_pump_token_balance', { mint: order.mint, error: String(e) });
          }
        }

        await query(
          `
          UPDATE execution_orders
          SET status = 'CONFIRMED', txsig = $2, quote_response = $3, updated_at = NOW()
          WHERE id = $1
          `,
          [order.id, signature, quote]
        );

        if (order.side === 'BUY') {
          await upsertPositionFromBuy(order, quote);
        } else if (order.side === 'SELL') {
          await closePositionFromSell(order);
        }
        incMetric('orders.confirmed');

        await sendMessage(
          order.chat_id,
          [
            '✅ *Trade confirmed*',
            `Token: \`${order.mint.slice(0, 8)}...${order.mint.slice(-6)}\``,
            `Full mint: \`${order.mint}\``,
            `Side: \`${order.side}\``,
            `Spent: \`${(Number(order.amount_lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL\``,
            `Slippage: \`${swapResponse.dynamicSlippageReport?.slippageBps ?? attemptSlippageBps} bps\``,
            `Priority fee: \`${(attemptPriorityFeeLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL\``,
            attempt > 1 ? `Attempt: \`${attempt}/${MAX_ORDER_ATTEMPTS}\`` : '',
            `[View on Solscan](https://solscan.io/tx/${signature})`
          ].filter(Boolean).join('\n'),
          { replyMarkup: DASHBOARD_REPLY_MARKUP }
        );

        return true;
      } catch (error) {
        lastError = error;
        logger.info('order_attempt_failed', {
          orderId: order.id,
          attempt,
          maxAttempts: MAX_ORDER_ATTEMPTS,
          slippageBps: attemptSlippageBps,
          priorityFeeLamports: attemptPriorityFeeLamports,
          signature: lastSignature,
          message: error instanceof Error ? error.message : String(error)
        });

        if (confirmationWasUncertain || attempt >= MAX_ORDER_ATTEMPTS || !isRetryableOrderError(error)) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, attempt * 600));
      }
    }
  } catch (error: any) {
    lastError = error;
  }

  const tokenNotTradable = isTokenNotTradableError(lastError);
  const finalStatus = confirmationWasUncertain ? 'PROCESSING' : tokenNotTradable ? 'SKIPPED' : 'FAILED';
  const finalMessage = confirmationWasUncertain
    ? `confirmation_unknown:${lastSignature ?? 'no_signature'}:${lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown_error')}`
    : tokenNotTradable ? 'Jupiter route is not available for this token yet.'
    : lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown_error');

  await query(
    `
    UPDATE execution_orders
    SET status = $2, error_message = $3, updated_at = NOW()
    WHERE id = $1
    `,
    [order.id, finalStatus, finalMessage]
  );

  if (finalStatus === 'FAILED') {
    incMetric('orders.failed');
  }
  await sendMessage(order.chat_id, composeOrderCompletionNotice({
    confirmationWasUncertain,
    tokenNotTradable,
    mint: order.mint,
    finalMessage,
    attemptsUsed
  }).join('\n'), { replyMarkup: DASHBOARD_REPLY_MARKUP });

  if (finalStatus === 'FAILED' && registerFailure(`order:${order.user_id}`)) {
    await sendMessage(
      order.chat_id,
      'Alert: multiple order failures detected recently. Review settings, wallet balance, and RPC/Jupiter health.',
      { replyMarkup: DASHBOARD_REPLY_MARKUP }
    );
  }
  logger.error('order_failed', { orderId: order.id, status: finalStatus, message: finalMessage });

  return true;
}

async function processNextOrderOnce() {
  const order = await claimNextOrder();
  if (!order) {
    return false;
  }

  try {
    incMetric('orders.processing');
    const walletRecord = await buildWalletRecord(order);

    const secret = decodeWalletSecret(walletRecord);
    const signer = Keypair.fromSecretKey(secret);
    const quote = await getBestQuote(
      order.input_mint,
      order.output_mint,
      Number(order.amount_lamports),
      Number(order.slippage_bps ?? 300)
    );
    const swapResponse = await buildSwapTransactionForOrder(order, quote, signer.publicKey.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(swapResponse.swapTransaction!, 'base64'));
    tx.sign([signer]);

    const sendResult = await rpcPool.sendRawTransactionRace(tx.serialize(), {
      skipPreflight: shouldSkipPreflight(order.metadata),
      preflightCommitment: 'processed'
    });
    const signature = sendResult.signature;

    const confirmation = await rpcPool.confirmSignature(signature, 'confirmed');
    if (confirmation.value.err) {
      throw new Error(JSON.stringify(confirmation.value.err));
    }

    await query(
      `
      UPDATE execution_orders
      SET status = 'CONFIRMED', txsig = $2, quote_response = $3, updated_at = NOW()
      WHERE id = $1
      `,
      [order.id, signature, quote]
    );

    if (order.side === 'BUY') {
      await upsertPositionFromBuy(order, quote);
    } else if (order.side === 'SELL') {
      await closePositionFromSell(order);
    }
    incMetric('orders.confirmed');

    await sendMessage(
      order.chat_id,
      [
        '✅ *Trade confirmed*',
        `Token: \`${order.mint.slice(0, 8)}...${order.mint.slice(-6)}\``,
        `Full mint: \`${order.mint}\``,
        `Side: \`${order.side}\``,
        `Spent: \`${(Number(order.amount_lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL\``,
        `Slippage: \`${swapResponse.dynamicSlippageReport?.slippageBps ?? order.slippage_bps} bps\``,
        `Priority fee: \`${(Number(order.priority_fee_lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL\``,
        `[🔍 View on Solscan](https://solscan.io/tx/${signature})`
      ].join('\n'),
      { replyMarkup: DASHBOARD_REPLY_MARKUP }
    );
  } catch (error: any) {
    await query(
      `
      UPDATE execution_orders
      SET status = 'FAILED', error_message = $2, updated_at = NOW()
      WHERE id = $1
      `,
      [order.id, error.message]
    );

    incMetric('orders.failed');
    await sendMessage(order.chat_id, ['❌ *Trade failed*', `Token: \`${order.mint.slice(0, 8)}...${order.mint.slice(-6)}\``, `Reason: ${humanizeExecutionError(error)}`].join('\n'));
    if (registerFailure(`order:${order.user_id}`)) {
      await sendMessage(order.chat_id, 'Alert: multiple order failures detected recently. Review settings and RPC health.');
    }
    logger.error('order_failed', { orderId: order.id, message: error.message });
  }

  return true;
}

async function claimNextWithdrawal(): Promise<WithdrawalRow | null> {
  const result = await query<WithdrawalRow>(
    `
    WITH next_item AS (
      SELECT wr.id
      FROM withdrawal_requests wr
      WHERE wr.status = 'QUEUED'
      ORDER BY wr.created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE withdrawal_requests wr
    SET status = 'PROCESSING', updated_at = NOW()
    FROM next_item
    WHERE wr.id = next_item.id
    RETURNING
      wr.*,
      (SELECT tu.chat_id FROM telegram_users tu WHERE tu.id = wr.user_id) AS chat_id,
      (SELECT cw.public_key FROM custody_wallets cw WHERE cw.id = wr.wallet_id) AS public_key,
      (SELECT cw.encrypted_secret_key FROM custody_wallets cw WHERE cw.id = wr.wallet_id) AS encrypted_secret_key,
      (SELECT cw.secret_key_iv FROM custody_wallets cw WHERE cw.id = wr.wallet_id) AS secret_key_iv,
      (SELECT cw.secret_key_auth_tag FROM custody_wallets cw WHERE cw.id = wr.wallet_id) AS secret_key_auth_tag
    `
  );
  return result.rows[0] ?? null;
}

export async function processNextWithdrawal() {
  const request = await claimNextWithdrawal();
  if (!request) {
    return false;
  }

  try {
    const walletRecord = await buildWalletRecord(request);
    const signer = Keypair.fromSecretKey(decodeWalletSecret(walletRecord));
    const destination = new PublicKey(request.destination);
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: destination,
        lamports: Number(request.amount_lamports)
      })
    );

    const latestBlockhash = await rpcPool.withConnection(
      (connection) => connection.getLatestBlockhash('confirmed')
    );
    tx.recentBlockhash = latestBlockhash.blockhash;
    tx.feePayer = signer.publicKey;
    tx.sign(signer);

    const sendResult = await rpcPool.sendRawTransactionRace(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'processed'
    });
    const signature = sendResult.signature;
    const confirmation = await rpcPool.confirmSignature(signature, 'confirmed');
    if (confirmation.value.err) {
      throw new Error(JSON.stringify(confirmation.value.err));
    }

    await query(
      `
      UPDATE withdrawal_requests
      SET status = 'CONFIRMED', txsig = $2, updated_at = NOW()
      WHERE id = $1
      `,
      [request.id, signature]
    );

    await sendMessage(
      request.chat_id,
      [
        '✅ *Withdrawal confirmed*',
        `Amount: \`${(Number(request.amount_lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL\``,
        `To: \`${request.destination.slice(0, 8)}...${request.destination.slice(-6)}\``,
        `[🔍 View on Solscan](https://solscan.io/tx/${signature})`
      ].join('\n')
    );
    incMetric('withdrawals.confirmed');
  } catch (error: any) {
    await query(
      `
      UPDATE withdrawal_requests
      SET status = 'FAILED', error_message = $2, updated_at = NOW()
      WHERE id = $1
      `,
      [request.id, error.message]
    );
    await sendMessage(request.chat_id, ['❌ *Withdrawal failed*', `Reason: ${humanizeExecutionError(error)}`].join('\n'));
    incMetric('withdrawals.failed');
    if (registerFailure(`withdrawal:${request.user_id}`)) {
      await sendMessage(request.chat_id, 'Alert: multiple withdrawal failures detected recently.');
    }
    logger.error('withdrawal_failed', { requestId: request.id, message: error.message });
  }

  return true;
}

export async function enqueueManualTradeForUser(params: {
  userId: string;
  mint: string;
  amountSol?: number;
  slippageBps?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  idempotencyKey?: string;
}) {
  const user = await getUserWithWallet(params.userId);
  if (!user) {
    throw new Error('user_or_wallet_not_found');
  }

  const idemKey = params.idempotencyKey ?? `manual:${params.userId}:${params.mint}:${Math.floor(Date.now() / 30000)}`;
  const idemInsert = await query<{ idempotency_key: string }>(
    `
    INSERT INTO manual_trade_idempotency (user_id, idempotency_key)
    VALUES ($1, $2)
    ON CONFLICT (user_id, idempotency_key) DO NOTHING
    RETURNING idempotency_key
    `,
    [params.userId, idemKey]
  );
  if (!idemInsert.rows[0]) {
    throw new Error('duplicate_manual_trade_blocked');
  }

  const signalResult = await query<{ id: string }>(
    `
    INSERT INTO execution_signals (signal_key, mint, source, side, score, payload, status)
    VALUES ($1, $2, 'manual', 'BUY', 100, $3, 'QUEUED')
    RETURNING id
    `,
    [
      `manual:${params.userId}:${params.mint}:${Date.now()}`,
      params.mint,
      {
        mode: 'manual',
        signalSource: 'manual',
        stopLossPct: params.stopLossPct ?? Number(user.stop_loss_pct),
        takeProfitPct: params.takeProfitPct ?? Number(user.take_profit_pct)
      }
    ]
  );

  const amountSol = params.amountSol ?? Number(user.max_buy_sol);
  const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
  const slippageBps = params.slippageBps ?? Number(user.slippage_bps);
  if (!(await canUserOpenNewTrade(user.id, amountLamports))) {
    throw new Error('daily_limit_or_position_limit_reached');
  }

  const orderResult = await query<{ id: string }>(
    `
    INSERT INTO execution_orders (
      signal_id, user_id, wallet_id, mint, side, input_mint, output_mint, amount_lamports,
      requested_amount_sol, metadata, slippage_bps, priority_fee_lamports
    )
    VALUES ($1, $2, $3, $4, 'BUY', $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
    `,
    [
      signalResult.rows[0].id,
      user.id,
      user.wallet_id,
      params.mint,
      SOL_MINT,
      params.mint,
      amountLamports,
      amountSol,
      {
        mode: 'manual',
        signalSource: 'manual',
        stopLossPct: params.stopLossPct ?? Number(user.stop_loss_pct),
        takeProfitPct: params.takeProfitPct ?? Number(user.take_profit_pct)
      },
      slippageBps,
      Number(user.priority_fee_lamports)
    ]
  );

  return { signalId: signalResult.rows[0].id, orderId: orderResult.rows[0].id, amountSol, slippageBps };
}

export async function enqueueRiskExitForMint(params: {
  mint: string;
  source: string;
  reason: string;
  metadata?: Record<string, unknown>;
}) {
  const positions = await query<{
    id: string;
    user_id: string;
    wallet_id: string;
    mint: string;
    token_amount_raw: string;
    slippage_bps: number;
    priority_fee_lamports: string;
    chat_id: string;
  }>(
    `
    SELECT
      p.id,
      p.user_id,
      p.wallet_id,
      p.mint,
      p.token_amount_raw::text,
      tu.slippage_bps,
      tu.priority_fee_lamports,
      tu.chat_id
    FROM positions p
    JOIN telegram_users tu ON tu.id = p.user_id
    WHERE p.mint = $1
      AND p.status = 'OPEN'
    `,
    [params.mint]
  );

  let queued = 0;

  for (const position of positions.rows) {
    const signalKey = `risk_exit:${params.source}:${position.id}`;
    const signalResult = await query<{ id: string }>(
      `
      INSERT INTO execution_signals (signal_key, mint, source, side, payload, status)
      VALUES ($1, $2, $3, 'SELL', $4, 'QUEUED')
      ON CONFLICT (signal_key) DO NOTHING
      RETURNING id
      `,
      [
        signalKey,
        position.mint,
        params.source,
        {
          reason: params.reason,
          positionId: position.id,
          ...(params.metadata ?? {})
        }
      ]
    );
    const signalId = signalResult.rows[0]?.id;
    if (!signalId) {
      continue;
    }

    const orderResult = await query<{ id: string }>(
      `
      INSERT INTO execution_orders (
        signal_id, user_id, wallet_id, mint, side, input_mint, output_mint, amount_lamports, metadata, slippage_bps, priority_fee_lamports
      ) VALUES ($1, $2, $3, $4, 'SELL', $4, $5, $6, $7, $8, $9)
      ON CONFLICT (signal_id, user_id, side) DO NOTHING
      RETURNING id
      `,
      [
        signalId,
        position.user_id,
        position.wallet_id,
        position.mint,
        SOL_MINT,
        Number(position.token_amount_raw),
        {
          reason: params.reason,
          priorityLevel: 'veryHigh',
          recommendedPriorityFeeLamports: Math.max(600_000, Number(position.priority_fee_lamports ?? 0)),
          ...(params.metadata ?? {})
        },
        Number(position.slippage_bps ?? 300),
        Math.max(600_000, Number(position.priority_fee_lamports ?? 0))
      ]
    );

    if (orderResult.rows[0]?.id) {
      queued += 1;
      await query('UPDATE positions SET status = $2, updated_at = NOW() WHERE id = $1', [position.id, 'CLOSING']);
      await sendMessage(
        position.chat_id,
        [
          '⚡ *Fast exit queued*',
          `Token: \`${position.mint.slice(0, 8)}...${position.mint.slice(-6)}\``,
          `Reason: \`${params.reason}\``
        ].join('\n')
      );
    }
  }

  return queued;
}

export async function scanDeposits() {
  const wallets = await query<{
    wallet_id: string;
    user_id: string;
    public_key: string;
    last_balance_lamports: string | null;
    chat_id: string;
  }>(
    `
    SELECT
      cw.id AS wallet_id,
      cw.user_id,
      cw.public_key,
      tu.chat_id,
      ws.last_balance_lamports
    FROM custody_wallets cw
    JOIN telegram_users tu ON tu.id = cw.user_id
    LEFT JOIN wallet_state ws ON ws.wallet_id = cw.id
    WHERE cw.is_active = true
    `
  );

  for (const wallet of wallets.rows) {
    try {
      const balance = await getWalletBalanceLamports(wallet.public_key);
      const previous = Number(wallet.last_balance_lamports ?? 0);
      if (balance > previous) {
        await query(
          `
          INSERT INTO deposits (user_id, wallet_id, amount_lamports, balance_after_lamports)
          VALUES ($1, $2, $3, $4)
          `,
          [wallet.user_id, wallet.wallet_id, balance - previous, balance]
        );
        await sendMessage(
          wallet.chat_id,
          [
            '💰 *Deposit detected!*',
            `Amount: \`+${((balance - previous) / LAMPORTS_PER_SOL).toFixed(6)} SOL\``,
            `New balance: \`${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL\``,
            `Wallet: \`${wallet.public_key.slice(0, 8)}...${wallet.public_key.slice(-6)}\``
          ].join('\n')
        );
        incMetric('deposits.detected');
      }

      await query(
        `
        INSERT INTO wallet_state (wallet_id, last_balance_lamports, last_checked_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        ON CONFLICT (wallet_id) DO UPDATE
        SET last_balance_lamports = EXCLUDED.last_balance_lamports,
            last_checked_at = EXCLUDED.last_checked_at,
            updated_at = NOW()
        `,
        [wallet.wallet_id, balance]
      );
    } catch (error: any) {
      logger.error('deposit_scan_error', { walletId: wallet.wallet_id, message: error.message });
    }
  }
}

export async function evaluateOpenPositions() {
  const positions = await query<{
    id: string;
    user_id: string;
    wallet_id: string;
    mint: string;
    token_amount_raw: string;
    entry_sol_lamports: string;
    stop_loss_pct: string;
    take_profit_pct: string;
    slippage_bps: number;
    priority_fee_lamports: string;
    chat_id: string;
  }>(
    `
    SELECT
      p.*,
      tu.chat_id,
      tu.slippage_bps,
      tu.priority_fee_lamports
    FROM positions p
    JOIN telegram_users tu ON tu.id = p.user_id
    WHERE p.status = 'OPEN'
    `
  );

  for (const position of positions.rows) {
    try {
      const quote = await getBestQuote(
        position.mint,
        SOL_MINT,
        Number(position.token_amount_raw),
        Number(position.slippage_bps ?? 300)
      );
      const currentOutLamports = Number(quote.outAmount ?? 0);
      const entryLamports = Number(position.entry_sol_lamports);
      if (currentOutLamports <= 0 || entryLamports <= 0) {
        continue;
      }

      const pnlPct = ((currentOutLamports - entryLamports) / entryLamports) * 100;
      const shouldStop = pnlPct <= -Number(position.stop_loss_pct);
      const shouldTakeProfit = pnlPct >= Number(position.take_profit_pct);
      if (!shouldStop && !shouldTakeProfit) {
        continue;
      }

      const retryBucket = Math.floor(Date.now() / (10 * 60 * 1000));
      const signalKey = `exit:${position.id}:${shouldTakeProfit ? 'tp' : 'sl'}:${retryBucket}`;
      const signalResult = await query<{ id: string }>(
        `
        INSERT INTO execution_signals (signal_key, mint, source, side, score, payload, status)
        VALUES ($1, $2, $3, 'SELL', NULL, $4, 'QUEUED')
        ON CONFLICT (signal_key) DO NOTHING
        RETURNING id
        `,
        [
          signalKey,
          position.mint,
          shouldTakeProfit ? 'auto_take_profit' : 'auto_stop_loss',
          { positionId: position.id, pnlPct }
        ]
      );
      const signalId = signalResult.rows[0]?.id;
      if (!signalId) {
        continue;
      }

      await query(
        `
        INSERT INTO execution_orders (
          signal_id, user_id, wallet_id, mint, side, input_mint, output_mint, amount_lamports, metadata, slippage_bps, priority_fee_lamports
        ) VALUES ($1, $2, $3, $4, 'SELL', $4, $5, $6, $7, $8, $9)
        ON CONFLICT (signal_id, user_id, side) DO NOTHING
        `,
        [
          signalId,
          position.user_id,
          position.wallet_id,
          position.mint,
          SOL_MINT,
          Number(position.token_amount_raw),
          { positionId: position.id, pnlPct },
          Number(position.slippage_bps ?? 300),
          Number(position.priority_fee_lamports ?? 0)
        ]
      );

      await query('UPDATE positions SET status = $2, updated_at = NOW() WHERE id = $1', [position.id, 'CLOSING']);
      await sendMessage(
        position.chat_id,
        [
          `${pnlPct >= 0 ? '🏁' : '🧯'} *Auto-exit triggered*`,
          `Token: \`${position.mint.slice(0, 8)}...${position.mint.slice(-6)}\``,
          `PnL: \`${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%\``,
          `Reason: \`${pnlPct >= 0 ? 'Take-profit hit' : 'Stop-loss hit'}\``,
          'Sell order queued.'
        ].join('\n')
      );
      incMetric('positions.auto_exit_triggered');
    } catch (error: any) {
      logger.error('position_monitor_error', { positionId: position.id, message: error.message });
    }
  }
}

export async function cleanupReplayGuards() {
  await query('DELETE FROM signal_replay_guard WHERE expires_at < NOW()');
}

export async function recoverStaleClosingPositions() {
  const result = await query<{ id: string }>(
    `
    UPDATE positions p
    SET status = 'OPEN', updated_at = NOW()
    WHERE p.status = 'CLOSING'
      AND p.updated_at < NOW() - INTERVAL '10 minutes'
      AND NOT EXISTS (
        SELECT 1
        FROM execution_orders eo
        WHERE eo.user_id = p.user_id
          AND eo.mint = p.mint
          AND eo.side = 'SELL'
          AND eo.status = 'CONFIRMED'
          AND eo.updated_at >= p.updated_at - INTERVAL '10 minutes'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM execution_orders eo
        WHERE eo.user_id = p.user_id
          AND eo.mint = p.mint
          AND eo.side = 'SELL'
          AND eo.status IN ('QUEUED', 'PROCESSING')
          AND eo.updated_at >= NOW() - INTERVAL '10 minutes'
      )
    RETURNING p.id
    `
  );

  if (result.rowCount) {
    logger.info('positions_reopened_after_stale_close', { count: result.rowCount });
  }
}

export async function reconcileConfirmedSellPositions() {
  const result = await query<{ id: string }>(
    `
    UPDATE positions p
    SET status = 'CLOSED', updated_at = NOW(), closed_at = COALESCE(p.closed_at, eo.updated_at)
    FROM execution_orders eo
    WHERE p.user_id = eo.user_id
      AND p.mint = eo.mint
      AND p.status = 'CLOSING'
      AND eo.side = 'SELL'
      AND eo.status = 'CONFIRMED'
      AND eo.updated_at >= p.updated_at - INTERVAL '10 minutes'
    RETURNING p.id
    `
  );

  if (result.rowCount) {
    logger.info('positions_reconciled_from_confirmed_sells', { count: result.rowCount });
  }
}
