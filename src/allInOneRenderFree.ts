// Single-process mode: API + Telegram + executor + monitor + sniper in one Node process.
// ENABLE_SNIPER_WORKER defaults to true so pump.fun monitoring starts automatically.
// If you experience memory issues on Render's free 512MB tier, set ENABLE_SNIPER_WORKER=false
// in your Render environment variables — but the bot won't detect launches without it.
process.env.ENABLE_SNIPER_WORKER ??= 'true';
process.env.ENABLE_METRICS_SNAPSHOT_LOGS ??= 'false';

await import('./allInOne.js');
