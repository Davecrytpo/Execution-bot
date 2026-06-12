import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getBuildInfo } from './lib/buildInfo.js';
import { adminRouter } from './routes/admin.js';
import { signalsRouter } from './routes/signals.js';
import { telegramRouter } from './routes/telegram.js';
import { getTelegramBotRuntimeStatus } from './bot/telegramBot.js';
import { rpcPool } from './lib/rpcPool.js';
import { getSniperRuntimeStatus } from './sniper/runtime.js';

export function createApp() {
  const app = express();
  const buildInfo = getBuildInfo();
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (_req, res) => {
    res.json({
      ok: true,
      service: 'solana-telegram-execution-bot',
      revision: buildInfo.revision,
      version: buildInfo.version,
      health: '/health'
    });
  });

  app.get('/health', async (_req, res) => {
    const telegram = getTelegramBotRuntimeStatus();
    const rpc = await rpcPool.getStatus().catch((error: any) => ({
      checkedAt: new Date().toISOString(),
      preferred: null,
      bestSlot: null,
      endpoints: [],
      error: error.message
    }));
    const sniper = config.enableSniperWorker
      ? await getSniperRuntimeStatus().catch((error: any) => ({
        state: 'DEGRADED',
        connected: false,
        websocketUrl: null,
        startedAt: null,
        lastConnectAt: null,
        lastDisconnectAt: null,
        lastHeartbeatAt: null,
        lastLaunchDetectedAt: null,
        lastQueuedSignalAt: null,
        lastLaunchMint: null,
        lastQueuedMint: null,
        lastError: error.message
      }))
      : null;

    res.json({
      ok: true,
      revision: buildInfo.revision,
      version: buildInfo.version,
      ready: !config.enableTelegramBot || ['LIVE', 'DEGRADED'].includes(telegram.state),
      components: {
        telegram: config.enableTelegramBot ? telegram : { state: 'DISABLED' },
        rpc: {
          checkedAt: rpc.checkedAt,
          preferred: rpc.preferred,
          bestSlot: rpc.bestSlot,
          endpoints: rpc.endpoints.map((endpoint) => ({
            name: endpoint.name,
            slot: endpoint.slot,
            lag: endpoint.lag,
            reachable: endpoint.reachable,
            error: endpoint.error
          })),
          ...('error' in rpc ? { error: rpc.error } : {})
        },
        sniper
      }
    });
  });

  app.use('/api/signals', signalsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/telegram', telegramRouter);

  return app;
}

export function startApi() {
  const app = createApp();
  return app.listen(config.port, () => {
    console.log(`API listening on port ${config.port}`);
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startApi();
}
