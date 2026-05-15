import { config } from '../config.js';

export type WalletRiskLabel = 'safe' | 'suspicious' | 'high_risk' | 'unknown';

export type LaunchStats = {
  buys: number;
  sells: number;
  uniqueBuyers: number;
  uniqueBuyerRatio: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  buyAcceleration: number;
  volumeAcceleration: number;
  suspiciousWallets: number;
  whaleExitCount: number;
  buyBurstCount: number;
};

export type LaunchSnapshot = {
  liquiditySol: number;
  curveProgressPct: number;
  creatorHoldingsPct: number;
  topHolderPct: number;
  mintAuthorityRevoked: boolean;
  marketCapSol: number;
  priceInSol: number;
  walletRiskLabel: WalletRiskLabel;
  walletRiskScore: number;
  stats: LaunchStats;
};

export type LaunchDecision = {
  action: 'BUY' | 'SKIP';
  score: number;
  hardRejects: string[];
  reasons: string[];
  priorityLevel: 'medium' | 'high' | 'veryHigh';
  recommendedSlippageBps: number;
  recommendedPriorityFeeLamports: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function decideLaunch(snapshot: LaunchSnapshot): LaunchDecision {
  const hardRejects: string[] = [];
  const reasons: string[] = [];

  if (snapshot.liquiditySol < config.sniperMinInitialLiquiditySol) {
    hardRejects.push('liquidity_below_floor');
  }
  if (snapshot.curveProgressPct > config.sniperMaxCurveProgressPct) {
    hardRejects.push('curve_progress_too_high');
  }
  if (snapshot.creatorHoldingsPct > config.sniperMaxDevWalletPct) {
    hardRejects.push('creator_wallet_concentration_too_high');
  }
  if (!snapshot.mintAuthorityRevoked) {
    hardRejects.push('mint_authority_not_revoked');
  }
  if (snapshot.topHolderPct > config.sniperMaxTopHolderPct) {
    hardRejects.push('top_holder_concentration_too_high');
  }
  if (snapshot.walletRiskLabel === 'high_risk') {
    hardRejects.push('creator_wallet_high_risk');
  }
  if (snapshot.stats.buys === 0) {
    hardRejects.push('no_early_buy_interest');
  }
  if (snapshot.stats.uniqueBuyerRatio < config.sniperMinUniqueBuyerRatio) {
    hardRejects.push('wallet_diversity_too_low');
  }
  if (snapshot.stats.buyBurstCount > config.sniperMaxBuyBurstCount) {
    hardRejects.push('launch_overcrowded');
  }
  if (snapshot.stats.suspiciousWallets > config.sniperMaxSuspiciousWallets) {
    hardRejects.push('suspicious_wallet_cluster_detected');
  }
  if (snapshot.stats.whaleExitCount > 0 && snapshot.stats.sellVolumeSol >= snapshot.stats.buyVolumeSol) {
    hardRejects.push('early_whale_exit_pressure');
  }
  if (snapshot.stats.buys > 0 && snapshot.stats.sells > snapshot.stats.buys && snapshot.stats.volumeAcceleration < 0) {
    hardRejects.push('sell_pressure_overwhelming');
  }

  let score = 50;
  score += clamp(snapshot.liquiditySol * 1.5, 0, 20);
  score += clamp(snapshot.stats.uniqueBuyers * 2, 0, 15);
  score += clamp(snapshot.stats.buyAcceleration * 8, -8, 12);
  score += clamp(snapshot.stats.volumeAcceleration * 8, -8, 12);
  score -= clamp((snapshot.creatorHoldingsPct / config.sniperMaxDevWalletPct) * 10, 0, 12);
  score -= clamp((snapshot.topHolderPct / config.sniperMaxTopHolderPct) * 8, 0, 10);
  score -= clamp(snapshot.stats.suspiciousWallets * 8, 0, 16);
  score -= clamp(snapshot.walletRiskScore / 5, 0, 20);

  if (snapshot.walletRiskLabel === 'safe') {
    score += 5;
  }
  if (snapshot.mintAuthorityRevoked) {
    score += 5;
  }
  if (snapshot.marketCapSol > 0 && snapshot.marketCapSol < 300) {
    score += 4;
  }
  if (snapshot.stats.buyVolumeSol > 10) {
    score += 5;
  }
  if (snapshot.stats.sellVolumeSol > snapshot.stats.buyVolumeSol * 0.6) {
    score -= 10;
  }

  score = clamp(Math.round(score), 0, 100);

  const aggressive = snapshot.liquiditySol < 12
    || snapshot.stats.buyBurstCount >= 12
    || snapshot.stats.buyAcceleration > 1.2;
  const ultraAggressive = snapshot.stats.buyBurstCount >= 20 || snapshot.stats.buyVolumeSol >= 20;

  const priorityLevel = ultraAggressive
    ? 'veryHigh'
    : aggressive
      ? 'high'
      : 'medium';

  const recommendedSlippageBps = ultraAggressive
    ? 900
    : aggressive
      ? 650
      : 400;

  const recommendedPriorityFeeLamports = priorityLevel === 'veryHigh'
    ? 800_000
    : priorityLevel === 'high'
      ? 450_000
      : 250_000;

  reasons.push(
    `liquidity=${snapshot.liquiditySol.toFixed(2)}SOL`,
    `curve=${snapshot.curveProgressPct.toFixed(1)}%`,
    `creator=${snapshot.creatorHoldingsPct.toFixed(1)}%`,
    `top_holder=${snapshot.topHolderPct.toFixed(1)}%`,
    `buyers=${snapshot.stats.uniqueBuyers}/${snapshot.stats.buys}`,
    `buy_volume=${snapshot.stats.buyVolumeSol.toFixed(2)}SOL`,
    `sell_volume=${snapshot.stats.sellVolumeSol.toFixed(2)}SOL`,
    `wallet_risk=${snapshot.walletRiskLabel}`
  );

  return {
    action: hardRejects.length ? 'SKIP' : 'BUY',
    score,
    hardRejects,
    reasons,
    priorityLevel,
    recommendedSlippageBps,
    recommendedPriorityFeeLamports
  };
}
