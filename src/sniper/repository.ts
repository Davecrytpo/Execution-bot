import { query } from '../lib/db.js';
import type { BondingCurveMetrics } from './pumpFun.js';
import type { WalletRiskLabel } from './scoring.js';

export type WalletReputation = {
  wallet: string;
  label: WalletRiskLabel;
  riskScore: number;
  launchesSeen: number;
  suspiciousEvents: number;
  rugsSeen: number;
};

function labelFromRiskScore(score: number): WalletRiskLabel {
  if (score >= 70) {
    return 'high_risk';
  }
  if (score >= 30) {
    return 'suspicious';
  }
  if (score === 0) {
    return 'unknown';
  }
  return 'safe';
}

export async function getWalletReputation(wallet: string): Promise<WalletReputation> {
  const result = await query<{
    wallet: string;
    label: string;
    risk_score: string;
    launches_seen: string;
    suspicious_events: string;
    rugs_seen: string;
  }>(
    `
    SELECT wallet, label, risk_score::text, launches_seen::text, suspicious_events::text, rugs_seen::text
    FROM sniper_wallet_reputation
    WHERE wallet = $1
    `,
    [wallet]
  );

  const row = result.rows[0];
  if (!row) {
    return {
      wallet,
      label: 'unknown',
      riskScore: 0,
      launchesSeen: 0,
      suspiciousEvents: 0,
      rugsSeen: 0
    };
  }

  return {
    wallet: row.wallet,
    label: row.label as WalletRiskLabel,
    riskScore: Number(row.risk_score),
    launchesSeen: Number(row.launches_seen),
    suspiciousEvents: Number(row.suspicious_events),
    rugsSeen: Number(row.rugs_seen)
  };
}

export async function touchWalletReputation(params: {
  wallet: string;
  launchesSeenDelta?: number;
  suspiciousEventsDelta?: number;
  rugsSeenDelta?: number;
  metadata?: Record<string, unknown>;
}) {
  const existing = await getWalletReputation(params.wallet);
  const launchesSeen = existing.launchesSeen + (params.launchesSeenDelta ?? 0);
  const suspiciousEvents = existing.suspiciousEvents + (params.suspiciousEventsDelta ?? 0);
  const rugsSeen = existing.rugsSeen + (params.rugsSeenDelta ?? 0);
  const riskScore = Math.max(0, suspiciousEvents * 20 + rugsSeen * 40);
  const label = labelFromRiskScore(riskScore);

  await query(
    `
    INSERT INTO sniper_wallet_reputation (
      wallet, label, risk_score, launches_seen, suspicious_events, rugs_seen, metadata, last_seen_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    ON CONFLICT (wallet) DO UPDATE
    SET label = EXCLUDED.label,
        risk_score = EXCLUDED.risk_score,
        launches_seen = EXCLUDED.launches_seen,
        suspicious_events = EXCLUDED.suspicious_events,
        rugs_seen = EXCLUDED.rugs_seen,
        metadata = COALESCE(sniper_wallet_reputation.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        last_seen_at = NOW(),
        updated_at = NOW()
    `,
    [
      params.wallet,
      label,
      riskScore,
      launchesSeen,
      suspiciousEvents,
      rugsSeen,
      params.metadata ?? {}
    ]
  );

  return {
    wallet: params.wallet,
    label,
    riskScore,
    launchesSeen,
    suspiciousEvents,
    rugsSeen
  } satisfies WalletReputation;
}

export async function upsertSniperToken(params: {
  mint: string;
  bondingCurve: string;
  creatorWallet: string | null;
  deployerWallet: string | null;
  detectedSignature: string;
  launchSlot: number;
  status: string;
  decision: string | null;
  score: number | null;
  metrics: BondingCurveMetrics;
  metadata?: Record<string, unknown>;
}) {
  await query(
    `
    INSERT INTO sniper_tokens (
      mint,
      source,
      creator_wallet,
      deployer_wallet,
      bonding_curve,
      detected_signature,
      launch_slot,
      status,
      decision,
      score,
      price_in_sol,
      market_cap_sol,
      liquidity_sol,
      curve_progress_pct,
      decision_reason,
      metadata,
      updated_at
    ) VALUES (
      $1,
      'pumpfun',
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      $15,
      NOW()
    )
    ON CONFLICT (mint) DO UPDATE
    SET creator_wallet = COALESCE(EXCLUDED.creator_wallet, sniper_tokens.creator_wallet),
        deployer_wallet = COALESCE(EXCLUDED.deployer_wallet, sniper_tokens.deployer_wallet),
        bonding_curve = EXCLUDED.bonding_curve,
        detected_signature = EXCLUDED.detected_signature,
        launch_slot = EXCLUDED.launch_slot,
        status = EXCLUDED.status,
        decision = EXCLUDED.decision,
        score = EXCLUDED.score,
        price_in_sol = EXCLUDED.price_in_sol,
        market_cap_sol = EXCLUDED.market_cap_sol,
        liquidity_sol = EXCLUDED.liquidity_sol,
        curve_progress_pct = EXCLUDED.curve_progress_pct,
        decision_reason = EXCLUDED.decision_reason,
        metadata = COALESCE(sniper_tokens.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      params.mint,
      params.creatorWallet,
      params.deployerWallet,
      params.bondingCurve,
      params.detectedSignature,
      params.launchSlot,
      params.status,
      params.decision,
      params.score,
      params.metrics.priceInSol,
      params.metrics.marketCapSol,
      params.metrics.liquiditySol,
      params.metrics.curveProgressPct,
      params.decision ?? '',
      params.metadata ?? {}
    ]
  );
}

export async function updateSniperTokenStatus(
  mint: string,
  status: string,
  metadata?: Record<string, unknown>
) {
  await query(
    `
    UPDATE sniper_tokens
    SET status = $2,
        metadata = COALESCE(metadata, '{}'::jsonb) || $3,
        updated_at = NOW()
    WHERE mint = $1
    `,
    [mint, status, metadata ?? {}]
  );
}

export async function recordSniperEvent(params: {
  signature: string;
  mint: string;
  eventType: string;
  actorWallet: string | null;
  slot: number | null;
  solAmountLamports: number;
  tokenAmountRaw: bigint;
  metadata?: Record<string, unknown>;
}) {
  await query(
    `
    INSERT INTO sniper_events (
      signature,
      mint,
      event_type,
      actor_wallet,
      slot,
      sol_amount_lamports,
      token_amount_raw,
      metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (signature) DO NOTHING
    `,
    [
      params.signature,
      params.mint,
      params.eventType,
      params.actorWallet,
      params.slot,
      params.solAmountLamports,
      params.tokenAmountRaw.toString(),
      params.metadata ?? {}
    ]
  );
}

export async function countSuspiciousWalletCluster(wallets: string[]) {
  if (!wallets.length) {
    return 0;
  }

  const result = await query<{ count: string }>(
    `
    SELECT COUNT(*)::text AS count
    FROM (
      SELECT actor_wallet
      FROM sniper_events
      WHERE event_type = 'BUY'
        AND actor_wallet = ANY($1)
        AND created_at > NOW() - INTERVAL '24 hours'
      GROUP BY actor_wallet
      HAVING COUNT(DISTINCT mint) >= 4
    ) clustered
    `,
    [wallets]
  );

  return Number(result.rows[0]?.count ?? '0');
}
