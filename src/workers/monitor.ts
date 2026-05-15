import { config } from '../config.js';
import { getMetricsSnapshot } from '../lib/metrics.js';
import { logger } from '../lib/logger.js';
import { cleanupReplayGuards, evaluateOpenPositions, processNextWithdrawal, scanDeposits } from '../services/executionService.js';

async function main() {
  while (true) {
    try {
      await scanDeposits();
      await evaluateOpenPositions();
      await processNextWithdrawal();
      await cleanupReplayGuards();
      logger.info('metrics_snapshot', getMetricsSnapshot());
    } catch (error: any) {
      logger.error('monitor_loop_error', { message: error.message });
    }

    await new Promise((resolve) => setTimeout(resolve, config.monitorIntervalMs));
  }
}

main().catch((error) => {
  logger.error('monitor_fatal', { message: error.message });
  process.exit(1);
});
