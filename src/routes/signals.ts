import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { enqueueSignal } from '../services/executionService.js';
import { incMetric } from '../lib/metrics.js';
import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export const signalsRouter = Router();

const signalRateWindow = new Map<string, { count: number; windowStart: number }>();

function getReplayKey(body: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

async function isReplayDetected(replayKey: string) {
  const ttlSeconds = config.signalReplayWindowSeconds;
  const result = await query<{ replay_key: string }>(
    `
    INSERT INTO signal_replay_guard (replay_key, expires_at)
    VALUES ($1, NOW() + ($2::text || ' seconds')::interval)
    ON CONFLICT (replay_key) DO NOTHING
    RETURNING replay_key
    `,
    [replayKey, ttlSeconds]
  );
  return !result.rows[0];
}

function isRateLimited(identity: string) {
  const now = Date.now();
  const row = signalRateWindow.get(identity);
  if (!row || now - row.windowStart > config.signalRateLimitWindowMs) {
    signalRateWindow.set(identity, { count: 1, windowStart: now });
    return false;
  }

  row.count += 1;
  if (row.count > config.signalRateLimitMax) {
    return true;
  }
  return false;
}

signalsRouter.use((req, res, next) => {
  const header = req.header('x-api-key');
  if (!config.apiSharedSecret || header !== config.apiSharedSecret) {
    incMetric('api.signals.unauthorized');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const identity = `${req.ip ?? 'unknown'}:${header ?? ''}`;
  if (isRateLimited(identity)) {
    incMetric('api.signals.rate_limited');
    return res.status(429).json({ error: 'rate_limited' });
  }

  next();
});

signalsRouter.post('/', async (req, res) => {
  try {
    const { mint, source } = req.body ?? {};
    if (!mint || !source) {
      return res.status(400).json({ error: 'mint_and_source_required' });
    }

    const replayKey = getReplayKey(req.body);
    if (await isReplayDetected(replayKey)) {
      incMetric('api.signals.replay_blocked');
      return res.status(409).json({ error: 'replay_detected' });
    }

    const result = await enqueueSignal(req.body);
    incMetric('api.signals.accepted');
    return res.json({ ok: true, ...result });
  } catch (error: any) {
    logger.error('signal_enqueue_failed', { message: error.message });
    incMetric('api.signals.failed');
    return res.status(400).json({ error: error.message ?? 'signal_enqueue_failed' });
  }
});
