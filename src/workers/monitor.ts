import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { getMetricsSnapshot } from '../lib/metrics.js';
import { logger } from '../lib/logger.js';
import { cleanupReplayGuards, evaluateOpenPositions, processNextWithdrawal, scanDeposits } from '../services/executionService.js';

export async function startMonitorWorker(signal?: AbortSignal) {
  while (!signal?.aborted) {
    try {
      await scanDeposits();
      await evaluateOpenPositions();
      await processNextWithdrawal();
      await cleanupReplayGuards();
      if (config.enableMetricsSnapshotLogs) {
        logger.info('metrics_snapshot', getMetricsSnapshot());
      }
    } catch (error: any) {
      if (signal?.aborted) {
        break;
      }
      logger.error('monitor_loop_error', { message: error.message });
    }

    if (signal?.aborted) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, config.monitorIntervalMs));
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startMonitorWorker().catch((error) => {
    logger.error('monitor_fatal', { message: error.message });
    process.exit(1);
  });
}
