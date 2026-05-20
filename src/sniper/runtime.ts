export type SniperWorkerState =
  | 'UNSEEN'
  | 'STARTING'
  | 'LIVE'
  | 'DEGRADED'
  | 'STOPPED';

export type SniperRuntimeStatus = {
  state: SniperWorkerState;
  connected: boolean;
  websocketUrl: string | null;
  startedAt: string | null;
  lastConnectAt: string | null;
  lastDisconnectAt: string | null;
  lastHeartbeatAt: string | null;
  lastLaunchDetectedAt: string | null;
  lastQueuedSignalAt: string | null;
  lastLaunchMint: string | null;
  lastQueuedMint: string | null;
  lastError: string | null;
};

const runtimeStatus: SniperRuntimeStatus = {
  state: 'UNSEEN',
  connected: false,
  websocketUrl: null,
  startedAt: null,
  lastConnectAt: null,
  lastDisconnectAt: null,
  lastHeartbeatAt: null,
  lastLaunchDetectedAt: null,
  lastQueuedSignalAt: null,
  lastLaunchMint: null,
  lastQueuedMint: null,
  lastError: null
};

function nowIso() {
  return new Date().toISOString();
}

export function getSniperRuntimeStatus(): SniperRuntimeStatus {
  return { ...runtimeStatus };
}

export function markSniperWorkerStarting() {
  runtimeStatus.state = 'STARTING';
  runtimeStatus.connected = false;
  runtimeStatus.startedAt ??= nowIso();
  runtimeStatus.lastError = null;
}

export function markSniperWorkerLive(websocketUrl: string) {
  const now = nowIso();
  runtimeStatus.state = 'LIVE';
  runtimeStatus.connected = true;
  runtimeStatus.websocketUrl = websocketUrl;
  runtimeStatus.startedAt ??= now;
  runtimeStatus.lastConnectAt = now;
  runtimeStatus.lastHeartbeatAt = now;
  runtimeStatus.lastError = null;
}

export function markSniperWorkerHeartbeat() {
  runtimeStatus.connected = true;
  runtimeStatus.lastHeartbeatAt = nowIso();
  if (runtimeStatus.state === 'UNSEEN' || runtimeStatus.state === 'STARTING') {
    runtimeStatus.state = 'LIVE';
  }
}

export function markSniperWorkerDisconnected(errorMessage?: string) {
  runtimeStatus.connected = false;
  runtimeStatus.lastDisconnectAt = nowIso();
  runtimeStatus.state = runtimeStatus.startedAt ? 'DEGRADED' : 'STOPPED';
  if (errorMessage) {
    runtimeStatus.lastError = errorMessage;
  }
}

export function markSniperWorkerStopped(errorMessage?: string) {
  runtimeStatus.connected = false;
  runtimeStatus.lastDisconnectAt = nowIso();
  runtimeStatus.state = 'STOPPED';
  if (errorMessage) {
    runtimeStatus.lastError = errorMessage;
  }
}

export function markSniperLaunchDetected(mint: string) {
  runtimeStatus.lastLaunchDetectedAt = nowIso();
  runtimeStatus.lastLaunchMint = mint;
}

export function markSniperSignalQueued(mint: string) {
  runtimeStatus.lastQueuedSignalAt = nowIso();
  runtimeStatus.lastQueuedMint = mint;
}
