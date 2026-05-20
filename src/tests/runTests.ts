import assert from 'node:assert/strict';

process.env.CUSTODY_MASTER_KEY = 'test-master-key';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/test';
process.env.SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? 'test-bot-token';
process.env.API_SHARED_SECRET = process.env.API_SHARED_SECRET ?? 'test-secret';

function writeU64(buffer: Buffer, offset: number, value: bigint) {
  buffer.writeBigUInt64LE(value, offset);
}

async function run() {
  const { encryptSecret, decryptSecret } = await import('../lib/crypto.js');
  const { normalizeDatabaseUrl, resolveDatabaseSsl } = await import('../lib/db.js');
  const { sanitizeForLog } = await import('../lib/logger.js');
  const { evaluateTurboGuardRow, validateSignalPayload } = await import('../services/executionService.js');
  const { isValidPositiveSolAmount } = await import('../bot/wizardLogic.js');
  const {
    deriveAutoBuyExecutionState,
    deriveLaunchWorkerStatus,
    deriveSourceRoutingState,
    sourceModeLabel
  } = await import('../bot/dashboardState.js');
  const {
    computeBondingCurveMetrics,
    decodeBondingCurveState,
    decodePumpGlobalState,
    getPumpEventKindFromLogs
  } = await import('../sniper/pumpFun.js');
  const { decideLaunch } = await import('../sniper/scoring.js');

  const payload = encryptSecret('secret-value');
  assert.equal(decryptSecret(payload.encrypted, payload.iv, payload.authTag), 'secret-value');

  assert.doesNotThrow(() =>
    validateSignalPayload({
      mint: 'So11111111111111111111111111111111111111112',
      source: 'pumpfun',
      side: 'BUY',
      score: 70
    })
  );

  assert.throws(
    () =>
      validateSignalPayload({
        mint: 'So11111111111111111111111111111111111111112',
        source: 'pumpfun',
        side: 'HOLD'
      }),
    /invalid_side/
  );

  assert.throws(
    () =>
      validateSignalPayload({
        source: 'pumpfun'
      }),
    /mint_and_source_required/
  );

  assert.equal(
    evaluateTurboGuardRow({
      open_by_source: '1',
      recent_duplicate_orders: '0',
      recent_same_mint_orders: '0'
    }),
    true
  );
  assert.equal(
    evaluateTurboGuardRow({
      open_by_source: '3',
      recent_duplicate_orders: '0',
      recent_same_mint_orders: '0'
    }),
    false
  );
  assert.equal(
    evaluateTurboGuardRow({
      open_by_source: '0',
      recent_duplicate_orders: '1',
      recent_same_mint_orders: '0'
    }),
    false
  );

  assert.equal(isValidPositiveSolAmount('0.1'), true);
  assert.equal(isValidPositiveSolAmount('0'), false);
  assert.equal(isValidPositiveSolAmount('-2'), false);
  assert.equal(sourceModeLabel(['pumpfun', 'dexscreener']), 'Launch Sniper');
  assert.equal(sourceModeLabel(['copytrade']), 'Copy Trade only');

  const launchRouting = deriveSourceRoutingState(['pumpfun', 'dexscreener']);
  assert.equal(launchRouting.launchSourcesEnabled, true);
  assert.equal(launchRouting.copytradeEnabled, false);
  assert.equal(
    deriveAutoBuyExecutionState({
      autoBuyEnabled: true,
      routing: launchRouting,
      launchWorkerConfigured: true,
      workerState: 'LIVE'
    }).label,
    'LIVE'
  );
  assert.equal(
    deriveAutoBuyExecutionState({
      autoBuyEnabled: true,
      routing: deriveSourceRoutingState(['copytrade']),
      launchWorkerConfigured: true,
      workerState: 'STARTING'
    }).label,
    'STANDBY'
  );
  assert.equal(deriveLaunchWorkerStatus(false, 'LIVE'), 'PAUSED');
  assert.equal(deriveLaunchWorkerStatus(true, 'UNSEEN'), 'CONFIGURED');

  const sanitized = sanitizeForLog({
    url: 'wss://mainnet.helius-rpc.com/?api-key=super-secret-key',
    token: 'bot-token',
    nested: {
      authorization: 'Bearer abc123',
      message: 'https://example.com/path?token=abc123'
    }
  }) as {
    url: string;
    token: string;
    nested: {
      authorization: string;
      message: string;
    };
  };
  assert.match(sanitized.url, /api-key=\*\*\*/);
  assert.doesNotMatch(sanitized.url, /super-secret-key/);
  assert.equal(sanitized.token, '***');
  assert.equal(sanitized.nested.authorization, '***');
  assert.match(sanitized.nested.message, /token=\*\*\*/);
  assert.doesNotMatch(sanitized.nested.message, /abc123/);

  assert.deepEqual(
    resolveDatabaseSsl('postgresql://user:pass@db.internal:5432/app', {
      databaseSsl: 'true'
    }),
    { rejectUnauthorized: true }
  );
  assert.deepEqual(
    resolveDatabaseSsl('postgresql://user:pass@db.internal:5432/app', {
      databaseSsl: 'true',
      databaseSslRejectUnauthorized: 'false'
    }),
    { rejectUnauthorized: false }
  );
  assert.deepEqual(
    resolveDatabaseSsl('postgresql://user:pass@db.internal:5432/app?sslmode=require'),
    { rejectUnauthorized: true }
  );
  assert.deepEqual(
    resolveDatabaseSsl('postgresql://user:pass@project.supabase.co:5432/postgres'),
    { rejectUnauthorized: false }
  );
  assert.equal(
    resolveDatabaseSsl('postgresql://postgres:postgres@localhost:5432/test', {
      databaseSsl: 'false'
    }),
    undefined
  );
  assert.equal(
    normalizeDatabaseUrl('postgresql://user:pass@host/db?sslmode=require'),
    'postgresql://user:pass@host/db'
  );
  assert.equal(
    normalizeDatabaseUrl('postgresql://user:pass@host/db?sslmode=require&channel_binding=require'),
    'postgresql://user:pass@host/db?channel_binding=require'
  );

  const curveBuffer = Buffer.alloc(64);
  writeU64(curveBuffer, 8, 1_073_000_000_000_000n);
  writeU64(curveBuffer, 16, 30_000_000_000n);
  writeU64(curveBuffer, 24, 793_100_000_000_000n);
  writeU64(curveBuffer, 32, 15_000_000_000n);
  writeU64(curveBuffer, 40, 1_000_000_000_000_000n);
  curveBuffer[48] = 0;

  const globalBuffer = Buffer.alloc(160);
  globalBuffer[8] = 1;
  writeU64(globalBuffer, 73, 1_073_000_000_000_000n);
  writeU64(globalBuffer, 81, 30_000_000_000n);
  writeU64(globalBuffer, 89, 793_100_000_000_000n);
  writeU64(globalBuffer, 97, 1_000_000_000_000_000n);
  writeU64(globalBuffer, 105, 100n);
  globalBuffer[145] = 1;

  const curveState = decodeBondingCurveState(curveBuffer);
  const globalState = decodePumpGlobalState(globalBuffer);
  const metrics = computeBondingCurveMetrics({
    curveState,
    globalState,
    decimals: 6,
    creatorHoldingsRaw: 50_000_000_000_000n,
    topHolderHoldingsRaw: 120_000_000_000_000n
  });

  assert.equal(curveState.complete, false);
  assert.equal(globalState.enableMigrate, true);
  assert.ok(metrics.liquiditySol >= 15);
  assert.equal(getPumpEventKindFromLogs(['Program log: Instruction: Buy']), 'buy');
  assert.equal(getPumpEventKindFromLogs(['Program log: Instruction: Create']), 'create');

  const buyDecision = decideLaunch({
    liquiditySol: 16,
    curveProgressPct: 12,
    creatorHoldingsPct: 5,
    topHolderPct: 12,
    mintAuthorityRevoked: true,
    marketCapSol: 180,
    priceInSol: 0.00003,
    walletRiskLabel: 'safe',
    walletRiskScore: 5,
    stats: {
      buys: 8,
      sells: 2,
      uniqueBuyers: 7,
      uniqueBuyerRatio: 0.875,
      buyVolumeSol: 14,
      sellVolumeSol: 3,
      buyAcceleration: 1.2,
      volumeAcceleration: 1.1,
      suspiciousWallets: 0,
      whaleExitCount: 0,
      buyBurstCount: 8
    }
  });
  assert.equal(buyDecision.action, 'BUY');
  assert.ok(buyDecision.score >= 70);

  const skipDecision = decideLaunch({
    liquiditySol: 3,
    curveProgressPct: 82,
    creatorHoldingsPct: 22,
    topHolderPct: 48,
    mintAuthorityRevoked: false,
    marketCapSol: 600,
    priceInSol: 0.0001,
    walletRiskLabel: 'high_risk',
    walletRiskScore: 90,
    stats: {
      buys: 2,
      sells: 4,
      uniqueBuyers: 1,
      uniqueBuyerRatio: 0.5,
      buyVolumeSol: 1.5,
      sellVolumeSol: 5,
      buyAcceleration: -0.5,
      volumeAcceleration: -0.75,
      suspiciousWallets: 4,
      whaleExitCount: 1,
      buyBurstCount: 40
    }
  });
  assert.equal(skipDecision.action, 'SKIP');
  assert.ok(skipDecision.hardRejects.length >= 5);

  console.log('All tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
