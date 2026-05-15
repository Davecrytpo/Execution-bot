import { logger } from '../lib/logger.js';
import { SniperService } from '../sniper/service.js';

async function main() {
  const service = new SniperService();
  await service.start();
}

main().catch((error: any) => {
  logger.error('sniper_worker_fatal', { message: error.message });
  process.exit(1);
});
