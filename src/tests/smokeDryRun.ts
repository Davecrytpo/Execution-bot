process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/test';
process.env.SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? 'test-bot-token';
process.env.API_SHARED_SECRET = process.env.API_SHARED_SECRET ?? 'test-secret';
process.env.CUSTODY_MASTER_KEY = process.env.CUSTODY_MASTER_KEY ?? 'test-master-key';

async function run() {
  const { config } = await import('../config.js');
  const { validateSignalPayload, evaluateTurboGuardRow } = await import('../services/executionService.js');
  const { isValidPositiveSolAmount } = await import('../bot/wizardLogic.js');

  validateSignalPayload({
    mint: 'So11111111111111111111111111111111111111112',
    source: 'smoke',
    side: 'BUY',
    score: 80
  });

  const turboPass = evaluateTurboGuardRow({
    open_by_source: '0',
    recent_duplicate_orders: '0',
    recent_same_mint_orders: '0'
  });
  if (!turboPass) {
    throw new Error('smoke_turbo_eval_failed');
  }
  if (!isValidPositiveSolAmount('0.1')) {
    throw new Error('smoke_wizard_amount_failed');
  }

  console.log('Smoke dry run completed.');
  console.log(JSON.stringify({
    port: config.port,
    pollIntervalMs: config.pollIntervalMs,
    monitorIntervalMs: config.monitorIntervalMs
  }));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
