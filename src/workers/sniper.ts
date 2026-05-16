import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { SniperService } from '../sniper/service.js';

export async function startSniperWorker(signal?: AbortSignal) {
  const service = new SniperService();
  if (signal) {
    signal.addEventListener('abort', () => {
      void service.stop();
    }, { once: true });
  }
  await service.start();
  return service;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startSniperWorker().catch((error: any) => {
    logger.error('sniper_worker_fatal', { message: error.message });
    process.exit(1);
  });
}
