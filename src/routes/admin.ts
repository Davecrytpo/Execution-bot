import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { getMetricsSnapshot } from '../lib/metrics.js';
import { rpcPool } from '../lib/rpcPool.js';
import { getWebhookInfo } from '../lib/telegram.js';
import { getSniperRuntimeStatus } from '../sniper/runtime.js';

export const adminRouter = Router();

adminRouter.use((req, res, next) => {
  const header = req.header('x-api-key');
  if (!config.apiSharedSecret || header !== config.apiSharedSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

adminRouter.get('/summary', async (_req, res) => {
  try {
    const [users, wallets, signals, orders, positions, withdrawals, deposits] = await Promise.all([
      query<{ count: string }>('SELECT COUNT(*)::text AS count FROM telegram_users'),
      query<{ count: string }>('SELECT COUNT(*)::text AS count FROM custody_wallets'),
      query<{ count: string }>('SELECT COUNT(*)::text AS count FROM execution_signals'),
      query<{ count: string }>('SELECT COUNT(*)::text AS count FROM execution_orders'),
      query<{ count: string }>('SELECT COUNT(*)::text AS count FROM positions WHERE status IN (\'OPEN\', \'CLOSING\')'),
      query<{ count: string }>('SELECT COUNT(*)::text AS count FROM withdrawal_requests'),
      query<{ count: string }>('SELECT COUNT(*)::text AS count FROM deposits')
    ]);

    return res.json({
      users: Number(users.rows[0].count),
      wallets: Number(wallets.rows[0].count),
      signals: Number(signals.rows[0].count),
      orders: Number(orders.rows[0].count),
      openPositions: Number(positions.rows[0].count),
      withdrawals: Number(withdrawals.rows[0].count),
      deposits: Number(deposits.rows[0].count)
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message ?? 'admin_summary_failed' });
  }
});

adminRouter.get('/metrics', (_req, res) => {
  return res.json({
    metrics: getMetricsSnapshot()
  });
});

adminRouter.get('/telegram', async (_req, res) => {
  try {
    const webhook = await getWebhookInfo();
    return res.json({
      webhook: {
        url: webhook.url,
        pendingUpdateCount: webhook.pending_update_count,
        lastErrorDate: webhook.last_error_date,
        lastErrorMessage: webhook.last_error_message,
        lastSynchronizationErrorDate: webhook.last_synchronization_error_date,
        maxConnections: webhook.max_connections,
        allowedUpdates: webhook.allowed_updates
      }
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message ?? 'telegram_status_failed' });
  }
});

adminRouter.get('/trading-health', async (_req, res) => {
  try {
    const [
      users,
      sniperCounts,
      recentSniper,
      signalCounts,
      recentSignals,
      orderCounts,
      recentOrders
    ] = await Promise.all([
      query<{
        id: string;
        telegram_user_id: string;
        auto_buy_enabled: boolean;
        max_buy_sol: string;
        daily_limit_sol: string;
        min_score: string;
        degen_turbo_enabled: boolean;
        allowed_sources: string[];
        wallet_public_key: string | null;
        wallet_balance_sol: string | null;
        open_positions: string;
      }>(
        `
        SELECT
          tu.id,
          tu.telegram_user_id::text,
          tu.auto_buy_enabled,
          tu.max_buy_sol::text,
          tu.daily_limit_sol::text,
          tu.min_score::text,
          tu.degen_turbo_enabled,
          tu.allowed_sources,
          cw.public_key AS wallet_public_key,
          (ws.last_balance_lamports::numeric / 1000000000)::text AS wallet_balance_sol,
          COALESCE((
            SELECT COUNT(*)::text
            FROM positions p
            WHERE p.user_id = tu.id AND p.status IN ('OPEN', 'CLOSING')
          ), '0') AS open_positions
        FROM telegram_users tu
        LEFT JOIN custody_wallets cw ON cw.user_id = tu.id AND cw.is_active = true
        LEFT JOIN wallet_state ws ON ws.wallet_id = cw.id
        ORDER BY tu.updated_at DESC
        LIMIT 10
        `
      ),
      query<{ status: string; count: string }>(
        `
        SELECT status, COUNT(*)::text AS count
        FROM sniper_tokens
        GROUP BY status
        `
      ),
      query<{
        mint: string;
        status: string;
        score: string | null;
        decision: string | null;
        liquidity_sol: string | null;
        curve_progress_pct: string | null;
        detected_at: string;
        updated_at: string;
      }>(
        `
        SELECT mint, status, score::text, decision, liquidity_sol::text, curve_progress_pct::text,
               detected_at::text, updated_at::text
        FROM sniper_tokens
        ORDER BY detected_at DESC
        LIMIT 10
        `
      ),
      query<{ status: string; count: string }>(
        `
        SELECT status, COUNT(*)::text AS count
        FROM execution_signals
        GROUP BY status
        `
      ),
      query<{
        id: string;
        mint: string;
        source: string;
        side: string;
        score: string | null;
        status: string;
        created_at: string;
      }>(
        `
        SELECT id, mint, source, side, score::text, status, created_at::text
        FROM execution_signals
        ORDER BY created_at DESC
        LIMIT 10
        `
      ),
      query<{ status: string; count: string }>(
        `
        SELECT status, COUNT(*)::text AS count
        FROM execution_orders
        GROUP BY status
        `
      ),
      query<{
        id: string;
        mint: string;
        side: string;
        status: string;
        requested_amount_sol: string | null;
        txsig: string | null;
        error_message: string | null;
        created_at: string;
      }>(
        `
        SELECT id, mint, side, status, requested_amount_sol::text, txsig, error_message, created_at::text
        FROM execution_orders
        ORDER BY created_at DESC
        LIMIT 10
        `
      )
    ]);

    return res.json({
      users: users.rows.map((row) => ({
        ...row,
        max_buy_sol: Number(row.max_buy_sol),
        daily_limit_sol: Number(row.daily_limit_sol),
        min_score: Number(row.min_score),
        wallet_balance_sol: row.wallet_balance_sol === null ? null : Number(row.wallet_balance_sol),
        open_positions: Number(row.open_positions)
      })),
      sniper: {
        counts: Object.fromEntries(sniperCounts.rows.map((row) => [row.status, Number(row.count)])),
        recent: recentSniper.rows.map((row) => ({
          ...row,
          score: row.score === null ? null : Number(row.score),
          liquidity_sol: row.liquidity_sol === null ? null : Number(row.liquidity_sol),
          curve_progress_pct: row.curve_progress_pct === null ? null : Number(row.curve_progress_pct)
        }))
      },
      signals: {
        counts: Object.fromEntries(signalCounts.rows.map((row) => [row.status, Number(row.count)])),
        recent: recentSignals.rows.map((row) => ({
          ...row,
          score: row.score === null ? null : Number(row.score)
        }))
      },
      orders: {
        counts: Object.fromEntries(orderCounts.rows.map((row) => [row.status, Number(row.count)])),
        recent: recentOrders.rows.map((row) => ({
          ...row,
          requested_amount_sol: row.requested_amount_sol === null ? null : Number(row.requested_amount_sol)
        }))
      }
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message ?? 'trading_health_failed' });
  }
});

adminRouter.get('/sniper', async (_req, res) => {
  try {
    const [counts, recent, rpcStatus, runtime] = await Promise.all([
      query<{
        status: string;
        count: string;
      }>(
        `
        SELECT status, COUNT(*)::text AS count
        FROM sniper_tokens
        GROUP BY status
        `
      ),
      query<{
        mint: string;
        status: string;
        score: string | null;
        creator_wallet: string | null;
        liquidity_sol: string | null;
        curve_progress_pct: string | null;
        detected_at: string;
      }>(
        `
        SELECT mint, status, score::text, creator_wallet, liquidity_sol::text, curve_progress_pct::text, detected_at::text
        FROM sniper_tokens
        ORDER BY detected_at DESC
        LIMIT 25
        `
      ),
      rpcPool.getStatus(),
      getSniperRuntimeStatus()
    ]);

    return res.json({
      counts: Object.fromEntries(counts.rows.map((row) => [row.status, Number(row.count)])),
      recent: recent.rows.map((row) => ({
        ...row,
        score: row.score === null ? null : Number(row.score),
        liquidity_sol: row.liquidity_sol === null ? null : Number(row.liquidity_sol),
        curve_progress_pct: row.curve_progress_pct === null ? null : Number(row.curve_progress_pct)
      })),
      rpc: rpcStatus,
      runtime
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message ?? 'admin_sniper_failed' });
  }
});
