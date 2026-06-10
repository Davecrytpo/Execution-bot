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
  let score = 50;

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
    score -= 15;
  }
  if (snapshot.topHolderPct > config.sniperMaxTopHolderPct) {
    hardRejects.push('top_holder_concentration_too_high');
  }
  if (snapshot.walletRiskLabel === 'high_risk') {
    hardRejects.push('creator_wallet_high_risk');
  }
  if (config.sniperRequireEarlyBuyInterest && snapshot.stats.buys === 0) {
    hardRejects.push('no_early_buy_interest');
  } else if (snapshot.stats.buys === 0) {
    score -= 8;
  }
  if (config.sniperRequireWalletDiversity && snapshot.stats.uniqueBuyerRatio < config.sniperMinUniqueBuyerRatio) {
    hardRejects.push('wallet_diversity_too_low');
  } else if (snapshot.stats.uniqueBuyerRatio < config.sniperMinUniqueBuyerRatio) {
    score -= 8;
  }
  if (snapshot.stats.buyBurstCount > config.sniperMaxBuyBurstCount) {
    hardRejects.push('launch_overcrowded');
  }
  if (snapshot.stats.suspiciousWallets > config.sniperMaxSuspiciousWallets) {
    score -= 20;
  }
  if (snapshot.stats.whaleExitCount > 0 && snapshot.stats.sellVolumeSol >= snapshot.stats.buyVolumeSol) {
    hardRejects.push('early_whale_exit_pressure');
  }
  if (snapshot.stats.buys > 0 && snapshot.stats.sells > snapshot.stats.buys && snapshot.stats.volumeAcceleration < 0) {
    hardRejects.push('sell_pressure_overwhelming');
  }

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
    ? 5000
    : aggressive
      ? 3000
      : 2000;

  const recommendedPriorityFeeLamports = priorityLevel === 'veryHigh'
    ? 5_000_000
    : priorityLevel === 'high'
      ? 2_000_000
      : 1_000_000;

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

  const canRiskBuy = config.sniperAllowRiskyBuys
    && score >= config.sniperRiskyBuyMinScore
    && !hardRejects.includes('creator_wallet_high_risk');

  return {
    action: hardRejects.length && !canRiskBuy ? 'SKIP' : 'BUY',
    score,
    hardRejects: canRiskBuy ? [] : hardRejects,
    reasons,
    priorityLevel,
    recommendedSlippageBps,
    recommendedPriorityFeeLamports
  };
}
