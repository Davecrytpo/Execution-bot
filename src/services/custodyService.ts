import { Keypair, PublicKey } from '@solana/web3.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { query } from '../lib/db.js';
import { rpcPool } from '../lib/rpcPool.js';

export type Identity = {
  telegramUserId: number;
  chatId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
};

export type WalletRecord = {
  id: string;
  user_id: string;
  public_key: string;
  encrypted_secret_key: string;
  secret_key_iv: string;
  secret_key_auth_tag: string;
  export_shown_at: string | null;
};

export async function ensureUser(identity: Identity): Promise<string> {
  const result = await query<{ id: string }>(
    `
    INSERT INTO telegram_users (telegram_user_id, chat_id, username, first_name, last_name)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (telegram_user_id) DO UPDATE
    SET chat_id = EXCLUDED.chat_id,
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        last_name = EXCLUDED.last_name,
        updated_at = NOW()
    RETURNING id
    `,
    [
      identity.telegramUserId,
      identity.chatId,
      identity.username ?? null,
      identity.firstName ?? null,
      identity.lastName ?? null
    ]
  );

  return result.rows[0].id;
}

export async function getWalletForUser(userId: string): Promise<WalletRecord | null> {
  const result = await query<WalletRecord>(
    `
    SELECT *
    FROM custody_wallets
    WHERE user_id = $1 AND is_active = true
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] ?? null;
}

export async function getOrCreateWallet(identity: Identity): Promise<{ userId: string; wallet: WalletRecord; exportedKey?: string }> {
  const userId = await ensureUser(identity);
  const existing = await getWalletForUser(userId);
  if (existing) {
    return { userId, wallet: existing };
  }

  const keypair = Keypair.generate();
  const exportedKey = Buffer.from(keypair.secretKey).toString('base64');
  const encrypted = encryptSecret(exportedKey);

  const result = await query<WalletRecord>(
    `
    INSERT INTO custody_wallets (user_id, public_key, encrypted_secret_key, secret_key_iv, secret_key_auth_tag)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
    `,
    [userId, keypair.publicKey.toBase58(), encrypted.encrypted, encrypted.iv, encrypted.authTag]
  );

  return { userId, wallet: result.rows[0], exportedKey };
}

export function decodeWalletSecret(wallet: WalletRecord): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      decryptSecret(wallet.encrypted_secret_key, wallet.secret_key_iv, wallet.secret_key_auth_tag),
      'base64'
    )
  );
}

export async function exportWalletSecret(walletId: string): Promise<string> {
  const result = await query<WalletRecord>('SELECT * FROM custody_wallets WHERE id = $1', [walletId]);
  const wallet = result.rows[0];
  const exported = decryptSecret(wallet.encrypted_secret_key, wallet.secret_key_iv, wallet.secret_key_auth_tag);

  await query(
    'UPDATE custody_wallets SET export_shown_at = NOW(), updated_at = NOW() WHERE id = $1',
    [walletId]
  );

  return exported;
}

export async function updateUserSettings(
  userId: string,
  updates: {
    autoBuyEnabled?: boolean;
    autoSellEnabled?: boolean;
    maxBuySol?: number;
    dailyLimitSol?: number;
    minScore?: number;
    degenTurboEnabled?: boolean;
    allowedSources?: string[];
    stopLossPct?: number;
    takeProfitPct?: number;
    slippageBps?: number;
    priorityFeeLamports?: number;
  }
) {
  if (updates.stopLossPct !== undefined) {
    await query(
      'UPDATE telegram_users SET stop_loss_pct = $1, updated_at = NOW() WHERE id = $2',
      [updates.stopLossPct, userId]
    );
  }

  if (updates.takeProfitPct !== undefined) {
    await query(
      'UPDATE telegram_users SET take_profit_pct = $1, updated_at = NOW() WHERE id = $2',
      [updates.takeProfitPct, userId]
    );
  }

  if (updates.slippageBps !== undefined) {
    await query(
      'UPDATE telegram_users SET slippage_bps = $1, updated_at = NOW() WHERE id = $2',
      [updates.slippageBps, userId]
    );
  }

  if (updates.priorityFeeLamports !== undefined) {
    await query(
      'UPDATE telegram_users SET priority_fee_lamports = $1, updated_at = NOW() WHERE id = $2',
      [updates.priorityFeeLamports, userId]
    );
  }

  if (updates.autoBuyEnabled !== undefined) {
    await query(
      'UPDATE telegram_users SET auto_buy_enabled = $1, updated_at = NOW() WHERE id = $2',
      [updates.autoBuyEnabled, userId]
    );
  }

  if (updates.autoSellEnabled !== undefined) {
    await query(
      'UPDATE telegram_users SET auto_sell_enabled = $1, updated_at = NOW() WHERE id = $2',
      [updates.autoSellEnabled, userId]
    );
  }

  if (updates.maxBuySol !== undefined) {
    await query(
      'UPDATE telegram_users SET max_buy_sol = $1, updated_at = NOW() WHERE id = $2',
      [updates.maxBuySol, userId]
    );
  }

  if (updates.dailyLimitSol !== undefined) {
    await query(
      'UPDATE telegram_users SET daily_limit_sol = $1, updated_at = NOW() WHERE id = $2',
      [updates.dailyLimitSol, userId]
    );
  }

  if (updates.minScore !== undefined) {
    await query(
      'UPDATE telegram_users SET min_score = $1, updated_at = NOW() WHERE id = $2',
      [updates.minScore, userId]
    );
  }

  if (updates.degenTurboEnabled !== undefined) {
    await query(
      'UPDATE telegram_users SET degen_turbo_enabled = $1, updated_at = NOW() WHERE id = $2',
      [updates.degenTurboEnabled, userId]
    );
  }

  if (updates.allowedSources !== undefined) {
    await query(
      'UPDATE telegram_users SET allowed_sources = $1, updated_at = NOW() WHERE id = $2',
      [updates.allowedSources, userId]
    );
  }
}

export async function getUserSettings(userId: string) {
  const result = await query(
    `
    SELECT auto_buy_enabled, auto_sell_enabled, max_buy_sol, daily_limit_sol, min_score, degen_turbo_enabled, stop_loss_pct, take_profit_pct, slippage_bps, priority_fee_lamports, allowed_sources, withdraw_max_per_tx_sol, withdraw_daily_limit_sol, withdraw_address_cooldown_minutes, last_withdraw_destination, last_withdraw_destination_set_at
    FROM telegram_users
    WHERE id = $1
    `,
    [userId]
  );

  return result.rows[0];
}

export async function getRecentOrders(userId: string) {
  const result = await query(
    `
    SELECT mint, side, status, txsig, error_message, created_at
    FROM execution_orders
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 5
    `,
    [userId]
  );

  return result.rows;
}

export async function getOpenPositions(userId: string) {
  const result = await query<{
    mint: string;
    token_amount_raw: string;
    entry_sol_lamports: string;
    entry_price_in_sol: string;
    stop_loss_pct: string;
    take_profit_pct: string;
    status: string;
    opened_at: string;
  }>(
    `
    SELECT mint, token_amount_raw::text, entry_sol_lamports::text, entry_price_in_sol::text, stop_loss_pct::text, take_profit_pct::text, status, opened_at
    FROM positions
    WHERE user_id = $1
      AND status IN ('OPEN', 'CLOSING')
    ORDER BY opened_at DESC
    LIMIT 10
    `,
    [userId]
  );

  return result.rows;
}

export async function getLatestDecisionReason(userId: string) {
  const result = await query<{
    mint: string;
    side: string;
    source: string;
    score: string | null;
    signal_status: string;
    order_status: string;
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(
    `
    SELECT
      eo.mint,
      eo.side,
      es.source,
      es.score::text,
      es.status AS signal_status,
      eo.status AS order_status,
      es.payload,
      eo.metadata,
      eo.created_at
    FROM execution_orders eo
    JOIN execution_signals es ON es.id = eo.signal_id
    WHERE eo.user_id = $1
    ORDER BY eo.created_at DESC
    LIMIT 1
    `,
    [userId]
  );

  return result.rows[0] ?? null;
}

export async function getWalletBalance(publicKey: string): Promise<number> {
  const lamports = await rpcPool.withConnection(
    (connection) => connection.getBalance(new PublicKey(publicKey))
  );
  return lamports / 1e9;
}

export async function getWalletBalanceLamports(publicKey: string): Promise<number> {
  return rpcPool.withConnection(
    (connection) => connection.getBalance(new PublicKey(publicKey))
  );
}

export async function getDepositHistory(userId: string) {
  const result = await query(
    `
    SELECT amount_lamports, balance_after_lamports, detected_at
    FROM deposits
    WHERE user_id = $1
    ORDER BY detected_at DESC
    LIMIT 10
    `,
    [userId]
  );

  return result.rows;
}

export async function createWithdrawalRequest(userId: string, walletId: string, destination: string, amountSol: number) {
  const amountLamports = Math.floor(amountSol * 1_000_000_000);
  const checks = await query<{
    withdraw_max_per_tx_sol: string;
    withdraw_daily_limit_sol: string;
    withdraw_address_cooldown_minutes: number;
    last_withdraw_destination: string | null;
    last_withdraw_destination_set_at: string | null;
    withdrawn_today_lamports: string;
  }>(
    `
    SELECT
      tu.withdraw_max_per_tx_sol::text,
      tu.withdraw_daily_limit_sol::text,
      tu.withdraw_address_cooldown_minutes,
      tu.last_withdraw_destination,
      tu.last_withdraw_destination_set_at::text,
      COALESCE((
        SELECT SUM(wr.amount_lamports)::text
        FROM withdrawal_requests wr
        WHERE wr.user_id = tu.id
          AND wr.status IN ('QUEUED', 'PROCESSING', 'CONFIRMED')
          AND wr.created_at > NOW() - INTERVAL '24 hours'
      ), '0') AS withdrawn_today_lamports
    FROM telegram_users tu
    WHERE tu.id = $1
    `,
    [userId]
  );
  const row = checks.rows[0];
  if (!row) {
    throw new Error('user_not_found');
  }

  if (amountSol > Number(row.withdraw_max_per_tx_sol)) {
    throw new Error('withdrawal_exceeds_max_per_tx');
  }

  const dailyLimitLamports = Math.floor(Number(row.withdraw_daily_limit_sol) * 1_000_000_000);
  const withdrawnTodayLamports = Number(row.withdrawn_today_lamports);
  if (withdrawnTodayLamports + amountLamports > dailyLimitLamports) {
    throw new Error('withdrawal_exceeds_daily_limit');
  }

  if (
    row.last_withdraw_destination
    && row.last_withdraw_destination !== destination
    && row.last_withdraw_destination_set_at
  ) {
    const cooldownRes = await query<{ ok: boolean }>(
      `
      SELECT (
        NOW() - $1::timestamptz >= ($2::text || ' minutes')::interval
      ) AS ok
      `,
      [row.last_withdraw_destination_set_at, row.withdraw_address_cooldown_minutes]
    );
    if (!cooldownRes.rows[0]?.ok) {
      throw new Error('withdraw_destination_cooldown_active');
    }
  }

  await query(
    `
    UPDATE telegram_users
    SET last_withdraw_destination = $1,
        last_withdraw_destination_set_at = NOW(),
        updated_at = NOW()
    WHERE id = $2
    `,
    [destination, userId]
  );

  const result = await query<{ id: string }>(
    `
    INSERT INTO withdrawal_requests (user_id, wallet_id, destination, amount_lamports)
    VALUES ($1, $2, $3, $4)
    RETURNING id
    `,
    [userId, walletId, destination, amountLamports]
  );

  return { id: result.rows[0].id, amountLamports };
}

export async function getWithdrawalHistory(userId: string) {
  const result = await query(
    `
    SELECT destination, amount_lamports, status, txsig, error_message, created_at
    FROM withdrawal_requests
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 10
    `,
    [userId]
  );

  return result.rows;
}

export async function getUserWithWallet(userId: string) {
  const result = await query<{
    id: string;
    chat_id: string;
    max_buy_sol: string;
    min_score: string;
    stop_loss_pct: string;
    take_profit_pct: string;
    slippage_bps: number;
    priority_fee_lamports: string;
    allowed_sources: string[];
    degen_turbo_enabled: boolean;
    wallet_id: string;
  }>(
    `
    SELECT
      tu.id,
      tu.chat_id,
      tu.max_buy_sol,
      tu.min_score,
      tu.stop_loss_pct,
      tu.take_profit_pct,
      tu.slippage_bps,
      tu.priority_fee_lamports,
      tu.allowed_sources,
      tu.degen_turbo_enabled,
      cw.id AS wallet_id
    FROM telegram_users tu
    JOIN custody_wallets cw ON cw.user_id = tu.id AND cw.is_active = true
    WHERE tu.id = $1
    `,
    [userId]
  );

  return result.rows[0] ?? null;
}
