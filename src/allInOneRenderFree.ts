// Single-process mode for Render free: API + Telegram + executor + monitor.
// The sniper worker exceeds the 512 MB free web-service limit, so this entrypoint
// keeps it off even if Render has ENABLE_SNIPER_WORKER=true set from an older deploy.
// Use npm run start:sniper on a separate worker, or a larger all-in-one service, for launches.
process.env.ENABLE_SNIPER_WORKER = 'false';
process.env.ENABLE_METRICS_SNAPSHOT_LOGS ??= 'false';

await import('./allInOne.js');
