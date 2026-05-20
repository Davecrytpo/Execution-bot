import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { SniperService } from '../sniper/service.js';
import {
  markSniperWorkerStarting,
  markSniperWorkerStopped
} from '../sniper/runtime.js';

export async function startSniperWorker(signal?: AbortSignal) {
  markSniperWorkerStarting();
  const service = new SniperService();
  if (signal) {
    signal.addEventListener('abort', () => {
      void service.stop();
    }, { once: true });
  }
  try {
    await service.start();
    return service;
  } catch (error: any) {
    markSniperWorkerStopped(error.message);
    throw error;
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startSniperWorker().catch((error: any) => {
    logger.error('sniper_worker_fatal', { message: error.message });
    process.exit(1);
  });
}
