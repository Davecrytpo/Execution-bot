import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { processNextOrder } from '../services/executionService.js';

async function main() {
  while (true) {
    try {
      const processed = await processNextOrder();
      if (!processed) {
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
      }
    } catch (error: any) {
      logger.error('worker_loop_error', { message: error.message });
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }
}

main().catch((error) => {
  logger.error('worker_fatal', { message: error.message });
  process.exit(1);
});
