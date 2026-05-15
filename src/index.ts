import express from 'express';
import { config } from './config.js';
import { adminRouter } from './routes/admin.js';
import { signalsRouter } from './routes/signals.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/signals', signalsRouter);
app.use('/api/admin', adminRouter);

app.listen(config.port, () => {
  console.log(`API listening on port ${config.port}`);
});
