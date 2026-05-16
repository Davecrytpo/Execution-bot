import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { processNextOrder } from '../services/executionService.js';

export async function startExecutorWorker(signal?: AbortSignal) {
  while (!signal?.aborted) {
    try {
      const processed = await processNextOrder();
      if (!processed) {
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
      }
    } catch (error: any) {
      if (signal?.aborted) {
        break;
      }
      logger.error('worker_loop_error', { message: error.message });
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startExecutorWorker().catch((error) => {
    logger.error('worker_fatal', { message: error.message });
    process.exit(1);
  });
}
