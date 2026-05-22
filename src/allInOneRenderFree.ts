// Single-process mode for Render free: API + Telegram + executor + monitor.
// The sniper worker is intentionally forced off here because it can push the
// free 512 MB instance over its memory limit. Use start:allinone or a separate
// worker service for sniper monitoring.
process.env.ENABLE_SNIPER_WORKER = 'false';
process.env.ENABLE_METRICS_SNAPSHOT_LOGS ??= 'false';

await import('./allInOne.js');
