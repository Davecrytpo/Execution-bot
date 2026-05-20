import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';

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
const SNIPER_WORKER_NAME = 'sniper';
let lastPersistedHeartbeatAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function shouldPersistHeartbeat() {
  const now = Date.now();
  if (now - lastPersistedHeartbeatAt < 15_000) {
    return false;
  }
  lastPersistedHeartbeatAt = now;
  return true;
}

async function persistSniperRuntimeStatus() {
  try {
    await query(
      `
      INSERT INTO worker_runtime_status (
        worker_name,
        state,
        connected,
        websocket_url,
        started_at,
        last_connect_at,
        last_disconnect_at,
        last_heartbeat_at,
        last_launch_detected_at,
        last_queued_signal_at,
        last_launch_mint,
        last_queued_mint,
        last_error
      ) VALUES (
        $1, $2, $3, $4,
        $5::timestamptz, $6::timestamptz, $7::timestamptz, $8::timestamptz,
        $9::timestamptz, $10::timestamptz, $11, $12, $13
      )
      ON CONFLICT (worker_name) DO UPDATE
      SET state = EXCLUDED.state,
          connected = EXCLUDED.connected,
          websocket_url = EXCLUDED.websocket_url,
          started_at = EXCLUDED.started_at,
          last_connect_at = EXCLUDED.last_connect_at,
          last_disconnect_at = EXCLUDED.last_disconnect_at,
          last_heartbeat_at = EXCLUDED.last_heartbeat_at,
          last_launch_detected_at = EXCLUDED.last_launch_detected_at,
          last_queued_signal_at = EXCLUDED.last_queued_signal_at,
          last_launch_mint = EXCLUDED.last_launch_mint,
          last_queued_mint = EXCLUDED.last_queued_mint,
          last_error = EXCLUDED.last_error,
          updated_at = NOW()
      `,
      [
        SNIPER_WORKER_NAME,
        runtimeStatus.state,
        runtimeStatus.connected,
        runtimeStatus.websocketUrl,
        runtimeStatus.startedAt,
        runtimeStatus.lastConnectAt,
        runtimeStatus.lastDisconnectAt,
        runtimeStatus.lastHeartbeatAt,
        runtimeStatus.lastLaunchDetectedAt,
        runtimeStatus.lastQueuedSignalAt,
        runtimeStatus.lastLaunchMint,
        runtimeStatus.lastQueuedMint,
        runtimeStatus.lastError
      ]
    );
  } catch (error: any) {
    logger.error('sniper_runtime_persist_failed', { message: error.message });
  }
}

export function getLocalSniperRuntimeStatus(): SniperRuntimeStatus {
  return { ...runtimeStatus };
}

export async function getSniperRuntimeStatus(): Promise<SniperRuntimeStatus> {
  try {
    const result = await query<{
      state: SniperWorkerState;
      connected: boolean;
      websocket_url: string | null;
      started_at: string | null;
      last_connect_at: string | null;
      last_disconnect_at: string | null;
      last_heartbeat_at: string | null;
      last_launch_detected_at: string | null;
      last_queued_signal_at: string | null;
      last_launch_mint: string | null;
      last_queued_mint: string | null;
      last_error: string | null;
    }>(
      `
      SELECT
        state,
        connected,
        websocket_url,
        started_at::text,
        last_connect_at::text,
        last_disconnect_at::text,
        last_heartbeat_at::text,
        last_launch_detected_at::text,
        last_queued_signal_at::text,
        last_launch_mint,
        last_queued_mint,
        last_error
      FROM worker_runtime_status
      WHERE worker_name = $1
      `,
      [SNIPER_WORKER_NAME]
    );

    const row = result.rows[0];
    if (!row) {
      return getLocalSniperRuntimeStatus();
    }

    return {
      state: row.state,
      connected: row.connected,
      websocketUrl: row.websocket_url,
      startedAt: row.started_at,
      lastConnectAt: row.last_connect_at,
      lastDisconnectAt: row.last_disconnect_at,
      lastHeartbeatAt: row.last_heartbeat_at,
      lastLaunchDetectedAt: row.last_launch_detected_at,
      lastQueuedSignalAt: row.last_queued_signal_at,
      lastLaunchMint: row.last_launch_mint,
      lastQueuedMint: row.last_queued_mint,
      lastError: row.last_error
    };
  } catch (error: any) {
    logger.error('sniper_runtime_load_failed', { message: error.message });
    return getLocalSniperRuntimeStatus();
  }
}

export function markSniperWorkerStarting() {
  runtimeStatus.state = 'STARTING';
  runtimeStatus.connected = false;
  runtimeStatus.startedAt ??= nowIso();
  runtimeStatus.lastError = null;
  void persistSniperRuntimeStatus();
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
  void persistSniperRuntimeStatus();
}

export function markSniperWorkerHeartbeat() {
  runtimeStatus.connected = true;
  runtimeStatus.lastHeartbeatAt = nowIso();
  if (runtimeStatus.state === 'UNSEEN' || runtimeStatus.state === 'STARTING') {
    runtimeStatus.state = 'LIVE';
  }
  if (shouldPersistHeartbeat()) {
    void persistSniperRuntimeStatus();
  }
}

export function markSniperWorkerDisconnected(errorMessage?: string) {
  runtimeStatus.connected = false;
  runtimeStatus.lastDisconnectAt = nowIso();
  runtimeStatus.state = runtimeStatus.startedAt ? 'DEGRADED' : 'STOPPED';
  if (errorMessage) {
    runtimeStatus.lastError = errorMessage;
  }
  void persistSniperRuntimeStatus();
}

export function markSniperWorkerStopped(errorMessage?: string) {
  runtimeStatus.connected = false;
  runtimeStatus.lastDisconnectAt = nowIso();
  runtimeStatus.state = 'STOPPED';
  if (errorMessage) {
    runtimeStatus.lastError = errorMessage;
  }
  void persistSniperRuntimeStatus();
}

export function markSniperLaunchDetected(mint: string) {
  runtimeStatus.lastLaunchDetectedAt = nowIso();
  runtimeStatus.lastLaunchMint = mint;
  void persistSniperRuntimeStatus();
}

export function markSniperSignalQueued(mint: string) {
  runtimeStatus.lastQueuedSignalAt = nowIso();
  runtimeStatus.lastQueuedMint = mint;
  void persistSniperRuntimeStatus();
}
