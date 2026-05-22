import express from 'express';
import { pool } from './lib/db.js';
import { logger } from './lib/logger.js';
import { config } from './config.js';
import { getLocalSniperRuntimeStatus, getSniperRuntimeStatus } from './sniper/runtime.js';
import { startSniperWorker } from './workers/sniper.js';

async function main() {
  const abortController = new AbortController();
  let shuttingDown = false;

  const app = express();

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'sniper',
      sniper: getLocalSniperRuntimeStatus()
    });
  });

  app.get('/api/admin/sniper/health', (_req, res) => {
    getSniperRuntimeStatus()
      .then((status) => res.json(status))
      .catch((error: any) => {
        logger.error('sniper_render_free_status_failed', { message: error.message });
        res.status(500).json({ ok: false });
      });
  });

  const server = app.listen(config.port, () => {
    logger.info('sniper_render_free_health_server_started', { port: config.port });
  });

  const sniperTask = startSniperWorker(abortController.signal);
  sniperTask.catch((error: any) => {
    logger.error('sniper_render_free_worker_fatal', { message: error.message });
    if (!shuttingDown) {
      process.exit(1);
    }
  });

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('sniper_render_free_shutdown', { signal });
    abortController.abort();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await pool.end().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

main().catch((error: any) => {
  logger.error('sniper_render_free_fatal', { message: error.message });
  process.exit(1);
});
