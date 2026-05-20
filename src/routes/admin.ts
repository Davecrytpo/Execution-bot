import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../lib/db.js';
import { getMetricsSnapshot } from '../lib/metrics.js';
import { rpcPool } from '../lib/rpcPool.js';
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
