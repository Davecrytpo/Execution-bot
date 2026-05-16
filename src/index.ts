import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { adminRouter } from './routes/admin.js';
import { signalsRouter } from './routes/signals.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/signals', signalsRouter);
  app.use('/api/admin', adminRouter);

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
