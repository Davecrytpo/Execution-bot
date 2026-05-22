// Single-process mode: API + Telegram + executor + monitor + sniper in one Node process.
// ENABLE_SNIPER_WORKER defaults to true so pump.fun launch monitoring runs automatically.
// Migrations run automatically on startup via the build command: npm run build:render-free
process.env.ENABLE_SNIPER_WORKER ??= 'true';
process.env.ENABLE_METRICS_SNAPSHOT_LOGS ??= 'false';

await import('./allInOne.js');
