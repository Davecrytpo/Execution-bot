process.env.ENABLE_SNIPER_WORKER ??= 'false';
process.env.ENABLE_METRICS_SNAPSHOT_LOGS ??= 'false';

await import('./allInOne.js');
