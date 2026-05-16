import { pool } from './lib/db.js';
import { logger } from './lib/logger.js';
import { config } from './config.js';
import { startApi } from './index.js';
import { startTelegramBot } from './bot/telegramBot.js';
import { startExecutorWorker } from './workers/executor.js';
import { startMonitorWorker } from './workers/monitor.js';
import { startSniperWorker } from './workers/sniper.js';

async function main() {
  const abortController = new AbortController();
  const server = startApi();
  let shuttingDown = false;

  const backgroundTasks: Array<Promise<unknown>> = [];

  if (config.enableTelegramBot) {
    backgroundTasks.push(startTelegramBot(abortController.signal));
  }
  if (config.enableExecutorWorker) {
    backgroundTasks.push(startExecutorWorker(abortController.signal));
  }
  if (config.enableMonitorWorker) {
    backgroundTasks.push(startMonitorWorker(abortController.signal));
  }
  if (config.enableSniperWorker) {
    backgroundTasks.push(startSniperWorker(abortController.signal));
  }

  logger.info('all_in_one_components_started', {
    telegramBot: config.enableTelegramBot,
    executorWorker: config.enableExecutorWorker,
    monitorWorker: config.enableMonitorWorker,
    sniperWorker: config.enableSniperWorker
  });

  for (const task of backgroundTasks) {
    task.catch((error: any) => {
      logger.error('all_in_one_component_fatal', { message: error.message });
    });
  }

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('all_in_one_shutdown', { signal });
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

  await Promise.allSettled(backgroundTasks);
}

main().catch((error: any) => {
  logger.error('all_in_one_fatal', { message: error.message });
  process.exit(1);
});
