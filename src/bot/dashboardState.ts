import type { SniperWorkerState } from '../sniper/runtime.js';

export type SourceRoutingState = {
  sourceMode: string[];
  pumpfunEnabled: boolean;
  dexscreenerEnabled: boolean;
  copytradeEnabled: boolean;
  launchSourcesEnabled: boolean;
  externalSourcesEnabled: boolean;
  anyEnabled: boolean;
};

export type AutoBuyExecutionState = {
  label: 'OFF' | 'LIVE' | 'STANDBY' | 'PAUSED' | 'STARTING' | 'DEGRADED' | 'BLOCKED';
  detail: string;
};

export function normalizeAllowedSources(rawSources: unknown): string[] {
  const normalized = Array.isArray(rawSources)
    ? rawSources
      .map((item) => String(item).trim().toLowerCase())
      .filter(Boolean)
    : [];

  return normalized.length ? [...new Set(normalized)] : ['*'];
}

export function sourceModeLabel(rawSources: unknown): string {
  const normalized = new Set(normalizeAllowedSources(rawSources));
  if (normalized.has('*')) {
    return 'All sources';
  }
  if (normalized.size === 0) {
    return 'No sources';
  }
  if (normalized.size === 1 && normalized.has('copytrade')) {
    return 'Copy Trade only';
  }
  if (
    normalized.size === 2
    && normalized.has('pumpfun')
    && normalized.has('dexscreener')
  ) {
    return 'Launch Sniper';
  }
  if (
    normalized.size === 3
    && normalized.has('pumpfun')
    && normalized.has('dexscreener')
    && normalized.has('copytrade')
  ) {
    return 'Hybrid';
  }
  return [...normalized].join(', ');
}

export function deriveSourceRoutingState(rawSources: unknown): SourceRoutingState {
  const sourceMode = normalizeAllowedSources(rawSources);
  const enabled = new Set(sourceMode);
  const all = enabled.has('*');
  const pumpfunEnabled = all || enabled.has('pumpfun');
  const dexscreenerEnabled = all || enabled.has('dexscreener');
  const copytradeEnabled = all || enabled.has('copytrade');

  return {
    sourceMode,
    pumpfunEnabled,
    dexscreenerEnabled,
    copytradeEnabled,
    launchSourcesEnabled: pumpfunEnabled,
    externalSourcesEnabled: dexscreenerEnabled || copytradeEnabled,
    anyEnabled: pumpfunEnabled || dexscreenerEnabled || copytradeEnabled
  };
}

export function deriveLaunchWorkerStatus(
  launchWorkerConfigured: boolean,
  workerState: SniperWorkerState
) {
  if (!launchWorkerConfigured) {
    return 'PAUSED';
  }

  if (workerState === 'UNSEEN') {
    return 'CONFIGURED';
  }

  return workerState;
}

export function derivePumpfunMonitorStatus(
  routing: SourceRoutingState,
  launchWorkerConfigured: boolean,
  workerState: SniperWorkerState
) {
  if (!routing.pumpfunEnabled) {
    return 'OFF';
  }

  if (!launchWorkerConfigured) {
    return 'PAUSED';
  }

  if (workerState === 'UNSEEN') {
    return 'STARTING';
  }

  return workerState;
}

export function deriveAutoBuyExecutionState(params: {
  autoBuyEnabled: boolean;
  routing: SourceRoutingState;
  launchWorkerConfigured: boolean;
  workerState: SniperWorkerState;
}): AutoBuyExecutionState {
  const {
    autoBuyEnabled,
    routing,
    launchWorkerConfigured,
    workerState
  } = params;

  if (!autoBuyEnabled) {
    return {
      label: 'OFF',
      detail: 'Auto-buy is disabled.'
    };
  }

  if (!routing.anyEnabled) {
    return {
      label: 'BLOCKED',
      detail: 'Auto-buy is enabled, but no signal source is routed to this account.'
    };
  }

  if (routing.launchSourcesEnabled && launchWorkerConfigured && workerState === 'LIVE') {
    return {
      label: 'LIVE',
      detail: routing.externalSourcesEnabled
        ? 'Launch monitoring is live and external sources are also accepted.'
        : 'Launch monitoring is live and can trigger buys immediately.'
    };
  }

  if (routing.launchSourcesEnabled && !launchWorkerConfigured && !routing.externalSourcesEnabled) {
    return {
      label: 'PAUSED',
      detail: 'Launch sources are routed, but the sniper worker is paused on this deployment.'
    };
  }

  if (
    routing.launchSourcesEnabled
    && launchWorkerConfigured
    && (workerState === 'UNSEEN' || workerState === 'STARTING')
    && !routing.externalSourcesEnabled
  ) {
    return {
      label: 'STARTING',
      detail: 'Launch sources are routed and the sniper worker is still starting.'
    };
  }

  if (
    routing.launchSourcesEnabled
    && launchWorkerConfigured
    && (workerState === 'DEGRADED' || workerState === 'STOPPED')
    && !routing.externalSourcesEnabled
  ) {
    return {
      label: 'DEGRADED',
      detail: 'Launch sources are routed, but the sniper worker is reconnecting or unhealthy.'
    };
  }

  if (routing.copytradeEnabled && routing.dexscreenerEnabled) {
    return {
      label: 'STANDBY',
      detail: 'Auto-buy is armed and waiting for external Copy Trade or DexScreener signals.'
    };
  }

  if (routing.copytradeEnabled) {
    return {
      label: 'STANDBY',
      detail: 'Auto-buy is armed and waiting for Copy Trade signals.'
    };
  }

  if (routing.dexscreenerEnabled) {
    return {
      label: 'STANDBY',
      detail: 'Auto-buy is armed and waiting for external DexScreener signals.'
    };
  }

  if (!launchWorkerConfigured) {
    return {
      label: 'PAUSED',
      detail: 'Launch routing is configured, but the sniper worker is paused on this deployment.'
    };
  }

  if (workerState === 'UNSEEN' || workerState === 'STARTING') {
    return {
      label: 'STARTING',
      detail: 'Launch routing is configured and the sniper worker is still starting.'
    };
  }

  if (workerState === 'DEGRADED' || workerState === 'STOPPED') {
    return {
      label: 'DEGRADED',
      detail: 'Launch routing is configured, but the sniper worker is reconnecting or unhealthy.'
    };
  }

  return {
    label: 'BLOCKED',
    detail: 'Auto-buy is enabled, but no executable signal pipeline is available.'
  };
}
