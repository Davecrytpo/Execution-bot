import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import WebSocket from 'ws';
import { config } from '../config.js';
import { fetchJson } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { incMetric } from '../lib/metrics.js';
import { rpcPool } from '../lib/rpcPool.js';
import { enqueueRiskExitForMint, enqueueSignal } from '../services/executionService.js';
import {
  markSniperLaunchDetected,
  markSniperSignalQueued,
  markSniperWorkerDisconnected,
  markSniperWorkerHeartbeat,
  markSniperWorkerLive,
  markSniperWorkerStopped
} from './runtime.js';
import {
  computeBondingCurveMetrics,
  decodeBondingCurveState,
  decodePumpGlobalState,
  deriveBondingCurveAddress,
  extractActorFromParsedTransaction,
  extractMintFromParsedTransaction,
  extractMintFromInstruction,
  extractTradeFlow,
  getPumpEventKindFromLogs,
  LAMPORTS_PER_SOL,
  PUMP_GLOBAL_ACCOUNT,
  TOKEN_PROGRAM_ID,
  type BondingCurveMetrics,
  type BondingCurveState,
  type PumpEventKind,
  type PumpGlobalState
} from './pumpFun.js';
import {
  countSuspiciousWalletCluster,
  getWalletReputation,
  recordSniperEvent,
  touchWalletReputation,
  updateSniperTokenStatus,
  upsertSniperToken
} from './repository.js';
import { decideLaunch, type LaunchSnapshot, type LaunchStats } from './scoring.js';

type SubscriptionRequest =
  | { type: 'logs' }
  | { type: 'account'; mint: string; bondingCurve: string };

type RuntimeTrade = {
  signature: string;
  timestamp: number;
  actorWallet: string | null;
  side: 'BUY' | 'SELL';
  tokenDeltaRaw: bigint;
  solDeltaLamports: number;
};

type DexScreenerMetadata = {
  pairAddress?: string;
  symbol?: string;
  socials?: string[];
  liquidityUsd?: number;
};

type RuntimeLaunchState = {
  mint: string;
  bondingCurve: string;
  creatorWallet: string | null;
  deployerWallet: string | null;
  signature: string;
  slot: number;
  detectedAt: number;
  curveState: BondingCurveState | null;
  mintDecimals: number;
  mintAuthorityRevoked: boolean;
  creatorHoldingsRaw: bigint;
  topHolderHoldingsRaw: bigint;
  walletRiskLabel: LaunchSnapshot['walletRiskLabel'];
  walletRiskScore: number;
  dexMetadata: DexScreenerMetadata | null;
  metrics: BondingCurveMetrics;
  trades: RuntimeTrade[];
  buyActors: Set<string>;
  peakRealSolReserves: bigint;
  decisionMade: boolean;
  decisionTimer: NodeJS.Timeout | null;
  queuedExit: boolean;
  migrationSeen: boolean;
};

type LogNotification = {
  params?: {
    result?: {
      context?: { slot?: number };
      value?: {
        signature?: string;
        logs?: string[];
      };
    };
    subscription?: number;
  };
};

type QueuedLogNotification = {
  payload: LogNotification;
  signature: string;
  eventKind: PumpEventKind;
};

type TradeEventKind = 'buy' | 'sell' | 'migrate';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const ROUTE_PROBE_AMOUNT_LAMPORTS = 5_000_000;

type AccountNotification = {
  params?: {
    result?: {
      value?: {
        data?: [string, string];
      };
    };
    subscription?: number;
  };
};

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absoluteNumber(value: number) {
  return Math.abs(value);
}

function normalizeSymbol(mint: string, symbol?: string) {
  return symbol?.trim() || mint.slice(0, 6);
}

function parseSubscriptionId(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }

  return null;
}

export function isJupiterRouteUnavailableError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error ?? '').toLowerCase();
  return message.includes('token_not_tradable')
    || message.includes('not tradable')
    || message.includes('could not find any route')
    || message.includes('no routes')
    || message.includes('route not found');
}

function isTradeEventKind(eventKind: PumpEventKind): eventKind is TradeEventKind {
  return eventKind === 'buy' || eventKind === 'sell' || eventKind === 'migrate';
}

function isResolvablePumpMint(mint: string) {
  return Boolean(mint) && mint !== SOL_MINT;
}

function decodeBondingCurveCandidate(data: Buffer) {
  try {
    return decodeBondingCurveState(data);
  } catch {
    return null;
  }
}

export class SniperService {
  private readonly websocketUrls = config.sniperWsUrls;
  private ws: WebSocket | null = null;
  private wsIndex = 0;
  private reconnectAttempts = 0;
  private lastMessageAt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private requestId = 1;
  private readonly pendingRequests = new Map<number, SubscriptionRequest>();
  private readonly accountSubscriptions = new Map<number, { mint: string; bondingCurve: string }>();
  private readonly launchStates = new Map<string, RuntimeLaunchState>();
  private readonly processedSignatures = new Map<string, number>();
  private readonly queuedSignatures = new Set<string>();
  private readonly logQueue: QueuedLogNotification[] = [];
  private logQueueRunning = false;
  private lastLogProcessedAt = 0;
  private lastCreateQueuedAt = 0;
  private readonly mintValidationCache = new Map<string, { expiresAt: number; value: boolean }>();
  private readonly createCandidateCache = new Map<string, { expiresAt: number; value: boolean }>();
  private globalState: PumpGlobalState | null = null;
  private logsSubscriptionId: number | null = null;
  private stopping = false;

  async start() {
    if (!this.websocketUrls.length) {
      throw new Error('SNIPER_WS_URL_or_HELIUS_WS_URL_required_for_sniper_logs_alchemy_ws_not_supported');
    }

    this.globalState = await this.fetchGlobalState().catch((error: any) => {
      logger.error('sniper_global_state_load_failed', { message: error.message });
      return null;
    });

    await this.connect().catch((error: any) => {
      markSniperWorkerDisconnected(error.message);
      logger.error('sniper_initial_connect_failed', { message: error.message });
    });
    this.startMaintenanceLoops();
  }

  async stop() {
    this.stopping = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
    }
    for (const state of this.launchStates.values()) {
      if (state.decisionTimer) {
        clearTimeout(state.decisionTimer);
      }
    }
    markSniperWorkerStopped();
    this.ws?.close();
  }

  private currentWebsocketUrl() {
    return this.websocketUrls[this.wsIndex % this.websocketUrls.length];
  }

  private nextRequestId() {
    const id = this.requestId;
    this.requestId += 1;
    return id;
  }

  private sendRequest(method: string, params: unknown[], request: SubscriptionRequest) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('websocket_not_open');
    }

    const id = this.nextRequestId();
    this.pendingRequests.set(id, request);
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    }));
  }

  private async connect() {
    const url = this.currentWebsocketUrl();
    logger.info('sniper_ws_connecting', { url });

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      const onOpen = () => {
        this.reconnectAttempts = 0;
        this.lastMessageAt = Date.now();
        markSniperWorkerLive(url);
        logger.info('sniper_ws_open', { url });
        resolve();
      };

      const onError = (error: Error) => {
        logger.error('sniper_ws_error', { url, message: error.message });
      };

      const onClose = async (code: number) => {
        if (this.stopping) {
          markSniperWorkerStopped(`ws_closed_${code}`);
        } else {
          markSniperWorkerDisconnected(`ws_closed_${code}`);
        }
        logger.error('sniper_ws_closed', { url, code });
        if (!this.stopping) {
          await this.scheduleReconnect();
        }
      };

      ws.once('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('pong', () => {
        this.lastMessageAt = Date.now();
        markSniperWorkerHeartbeat();
      });
      ws.on('message', (payload) => {
        this.lastMessageAt = Date.now();
        void this.handleMessage(payload.toString());
      });

      ws.once('error', reject);
    });

    this.subscribeCoreStreams();
    this.resubscribeCurves();
  }

  private subscribeCoreStreams() {
    this.sendRequest(
      'logsSubscribe',
      [
        {
          mentions: [config.pumpProgramId]
        },
        {
          commitment: 'processed'
        }
      ],
      { type: 'logs' }
    );
  }

  private resubscribeCurves() {
    for (const state of this.launchStates.values()) {
      this.subscribeCurve(state.mint, state.bondingCurve);
    }
  }

  private subscribeCurve(mint: string, bondingCurve: string) {
    try {
      this.sendRequest(
        'accountSubscribe',
        [
          bondingCurve,
          {
            encoding: 'base64',
            commitment: 'processed'
          }
        ],
        { type: 'account', mint, bondingCurve }
      );
    } catch (error: any) {
      logger.error('sniper_account_subscribe_failed', {
        mint,
        bondingCurve,
        message: error.message
      });
    }
  }

  private startMaintenanceLoops() {
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (Date.now() - this.lastMessageAt > config.wsFreezeThresholdMs) {
        logger.error('sniper_ws_freeze_detected', {
          lastMessageAt: this.lastMessageAt
        });
        this.ws.terminate();
        return;
      }

      this.ws.ping();
    }, config.wsHeartbeatMs);

    this.cleanupTimer = setInterval(() => {
      this.pruneProcessedSignatures();
      this.pruneLaunchStates();
    }, 30_000);

    this.statusTimer = setInterval(() => {
      logger.info('sniper_runtime_tick', {
        connected: this.ws?.readyState === WebSocket.OPEN,
        logsSubscriptionId: this.logsSubscriptionId,
        queueDepth: this.logQueue.length,
        trackedLaunches: this.launchStates.size,
        lastMessageAgeMs: this.lastMessageAt ? Date.now() - this.lastMessageAt : null,
        lastCreateQueuedAgeMs: this.lastCreateQueuedAt ? Date.now() - this.lastCreateQueuedAt : null
      });
    }, 60_000);
  }

  private async scheduleReconnect() {
    if (this.stopping) {
      return;
    }

    this.reconnectAttempts += 1;
    if (this.websocketUrls.length > 1) {
      this.wsIndex = (this.wsIndex + 1) % this.websocketUrls.length;
    }

    const delay = Math.min(
      config.wsReconnectBaseMs * Math.max(1, this.reconnectAttempts),
      config.wsReconnectMaxMs
    );

    await wait(delay);
    await this.connect().catch((error: any) => {
      logger.error('sniper_ws_reconnect_failed', { message: error.message });
    });
  }

  private async handleMessage(raw: string) {
    markSniperWorkerHeartbeat();
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch (error: any) {
      logger.error('sniper_ws_invalid_json', { message: error.message });
      return;
    }

    if (typeof payload.id === 'number' && this.pendingRequests.has(payload.id)) {
      const request = this.pendingRequests.get(payload.id)!;
      this.pendingRequests.delete(payload.id);

      if (request.type === 'logs') {
        const subscriptionId = parseSubscriptionId(payload.result);
        this.logsSubscriptionId = subscriptionId;
        if (subscriptionId === null) {
          const message = payload.error?.message ?? 'logs_subscription_missing_id';
          markSniperWorkerDisconnected(message);
          logger.error('sniper_logs_subscribe_failed', {
            message,
            code: payload.error?.code ?? null,
            result: payload.result ?? null
          });
          this.ws?.close(4000, 'logs_subscribe_failed');
        } else {
          logger.info('sniper_logs_subscribed', { subscriptionId });
        }
      } else if (request.type === 'account') {
        const subscriptionId = parseSubscriptionId(payload.result);
        if (subscriptionId === null) {
          logger.error('sniper_account_subscribe_failed', {
            mint: request.mint,
            bondingCurve: request.bondingCurve,
            message: payload.error?.message ?? 'account_subscription_missing_id',
            code: payload.error?.code ?? null,
            result: payload.result ?? null
          });
          return;
        }
        this.accountSubscriptions.set(subscriptionId, {
          mint: request.mint,
          bondingCurve: request.bondingCurve
        });
      }
      return;
    }

    if (payload.method === 'logsNotification') {
      this.enqueueLogNotification(payload as LogNotification);
      return;
    }

    if (payload.method === 'accountNotification') {
      await this.handleAccountNotification(payload as AccountNotification).catch((error: any) => {
        logger.error('sniper_account_notification_error', { message: error.message });
      });
    }
  }

  private enqueueLogNotification(payload: LogNotification) {
    const signature = payload.params?.result?.value?.signature;
    const logs = payload.params?.result?.value?.logs ?? [];

    if (!signature || !logs.length) {
      return;
    }

    if (this.processedSignatures.has(signature) || this.queuedSignatures.has(signature)) {
      return;
    }

    const eventKind = getPumpEventKindFromLogs(logs);
    if (eventKind === 'unknown') {
      return;
    }

    if (eventKind === 'create') {
      const now = Date.now();
      if (now - this.lastCreateQueuedAt < config.sniperCreateProcessIntervalMs) {
        incMetric('sniper.create_dropped');
        logger.info('sniper_create_dropped', {
          signature,
          intervalMs: config.sniperCreateProcessIntervalMs,
          sinceLastCreateMs: now - this.lastCreateQueuedAt
        });
        return;
      }
      this.lastCreateQueuedAt = now;
      logger.info('sniper_create_queued', {
        signature,
        queueDepth: this.logQueue.length
      });
    }

    if (eventKind !== 'create' && this.launchStates.size === 0) {
      return;
    }

    if (this.logQueue.length >= config.sniperLogQueueMax) {
      if (eventKind !== 'create') {
        incMetric('sniper.log_dropped');
        return;
      }

      const removableIndex = this.logQueue.findIndex((entry) => entry.eventKind !== 'create');
      if (removableIndex >= 0) {
        const [removed] = this.logQueue.splice(removableIndex, 1);
        this.queuedSignatures.delete(removed.signature);
      } else {
        incMetric('sniper.log_dropped');
        return;
      }
    }

    this.logQueue.push({ payload, signature, eventKind });
    this.queuedSignatures.add(signature);
    this.processLogQueue();
  }

  private processLogQueue() {
    if (this.logQueueRunning) {
      return;
    }

    this.logQueueRunning = true;
    void this.drainLogQueue();
  }

  private async drainLogQueue() {
    try {
      while (!this.stopping && this.logQueue.length) {
        const waitMs = Math.max(
          0,
          config.sniperLogProcessIntervalMs - (Date.now() - this.lastLogProcessedAt)
        );
        if (waitMs > 0) {
          await wait(waitMs);
        }

        const next = this.logQueue.shift();
        if (!next) {
          continue;
        }

        this.queuedSignatures.delete(next.signature);
        this.processedSignatures.set(next.signature, Date.now());
        this.lastLogProcessedAt = Date.now();

        logger.info('sniper_log_processing', {
          signature: next.signature,
          eventKind: next.eventKind
        });
        await this.handleLogNotification(next.payload, next.eventKind).catch((error: any) => {
          logger.error('sniper_log_notification_error', { message: error.message });
        });
      }
    } finally {
      this.logQueueRunning = false;
      if (this.logQueue.length && !this.stopping) {
        this.processLogQueue();
      }
    }
  }

  private async handleLogNotification(payload: LogNotification, eventKind: PumpEventKind) {
    const signature = payload.params?.result?.value?.signature;
    const slot = payload.params?.result?.context?.slot ?? 0;

    if (!signature) {
      return;
    }

    const tx = await this.fetchParsedTransaction(signature);
    if (!tx) {
      logger.info('sniper_parsed_transaction_unavailable', {
        signature,
        eventKind
      });
      return;
    }

    const mint = await this.resolveMint(tx, eventKind);
    if (!mint) {
      logger.error('sniper_mint_resolution_failed', { signature, eventKind });
      return;
    }

    const actorWallet = extractActorFromParsedTransaction(tx);

    if (eventKind === 'create') {
      await this.handleLaunchDetected({
        mint,
        signature,
        slot,
        tx,
        actorWallet
      });
      return;
    }

    if (!isTradeEventKind(eventKind)) {
      return;
    }

    await this.handleTradeEvent({
      mint,
      signature,
      slot,
      tx,
      actorWallet,
      eventKind
    });
  }

  private async handleAccountNotification(payload: AccountNotification) {
    const subscriptionId = payload.params?.subscription;
    const subscription = subscriptionId ? this.accountSubscriptions.get(subscriptionId) : null;
    const base64Data = payload.params?.result?.value?.data?.[0];

    if (!subscription || !base64Data) {
      return;
    }

    const state = this.launchStates.get(subscription.mint);
    if (!state) {
      return;
    }

    try {
      const buffer = Buffer.from(base64Data, 'base64');
      state.curveState = decodeBondingCurveState(buffer);
      state.metrics = computeBondingCurveMetrics({
        curveState: state.curveState,
        globalState: this.globalState,
        decimals: state.mintDecimals,
        creatorHoldingsRaw: state.creatorHoldingsRaw,
        topHolderHoldingsRaw: state.topHolderHoldingsRaw
      });
      state.peakRealSolReserves = state.peakRealSolReserves > state.curveState.realSolReserves
        ? state.peakRealSolReserves
        : state.curveState.realSolReserves;

      if (state.curveState.complete && !state.migrationSeen) {
        state.migrationSeen = true;
        await updateSniperTokenStatus(state.mint, 'MIGRATED', {
          complete: true
        });
      }

      await this.evaluateRiskExit(state);
    } catch (error: any) {
      logger.error('sniper_curve_decode_failed', {
        mint: subscription.mint,
        message: error.message
      });
    }
  }

  private async fetchParsedTransaction(signature: string) {
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const tx = await rpcPool.withConnection(
        (connection) => connection.getParsedTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        }),
        {
          preferPrimary: false,
          timeoutMs: config.rpcRequestTimeoutMs
        }
      );

      if (tx) {
        if (attempt > 1) {
          logger.info('sniper_parsed_transaction_loaded', {
            signature,
            attempt
          });
        }
        return tx;
      }

      logger.info('sniper_parsed_transaction_retry', {
        signature,
        attempt,
        attempts
      });
      await wait(1500);
    }

    return null;
  }

  private async resolveMint(tx: ParsedTransactionWithMeta, eventKind: PumpEventKind) {
    if (eventKind === 'create') {
      const instructionMint = await this.resolveCreateInstructionMint(tx);
      if (instructionMint) {
        logger.info('sniper_create_mint_resolved', {
          mint: instructionMint,
          method: 'instruction'
        });
        return instructionMint;
      }
    }

    const direct = extractMintFromParsedTransaction(tx, eventKind);
    if (direct && isResolvablePumpMint(direct)) {
      logger.info(eventKind === 'create' ? 'sniper_create_mint_resolved' : 'sniper_mint_resolved', {
        mint: direct,
        method: 'token_balances'
      });
      return direct;
    }
    if (eventKind === 'create' && direct) {
      logger.info('sniper_create_mint_candidate_rejected', {
        mint: direct,
        method: 'token_balances'
      });
    }

    const keys = tx.transaction.message.accountKeys.map((key) => new PublicKey(key.pubkey));
    const accounts = await rpcPool.withConnection(
      (connection) => connection.getMultipleAccountsInfo(keys),
      {
        preferPrimary: false
      }
    );

    const candidates = accounts
      .map((account, index) => ({ account, key: keys[index] }))
      .filter(({ account }) => account?.owner.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' && account.data.length === 82)
      .map(({ key }) => key.toBase58());

    for (const candidate of candidates) {
      if (!isResolvablePumpMint(candidate)) {
        continue;
      }

      logger.info('sniper_create_mint_resolved', {
        mint: candidate,
        method: 'account_scan'
      });
      return candidate;
    }

    if (eventKind === 'create') {
      logger.info('sniper_create_mint_candidates_rejected', {
        candidates
      });
    }

    return null;
  }

  private async resolveCreateInstructionMint(tx: ParsedTransactionWithMeta) {
    for (const instruction of tx.transaction.message.instructions) {
      const programId = 'programId' in instruction
        ? instruction.programId.toBase58()
        : '';

      if (programId !== config.pumpProgramId) {
        continue;
      }

      const candidate = extractMintFromInstruction(instruction);
      if (candidate && isResolvablePumpMint(candidate)) {
        return candidate;
      }
      if (candidate) {
        logger.info('sniper_create_instruction_candidate_rejected', {
          candidate
        });
      }
    }

    return null;
  }

  private async isTokenMint(address: string) {
    const cached = this.mintValidationCache.get(address);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    try {
      const info = await rpcPool.withConnection(
        (connection) => connection.getParsedAccountInfo(new PublicKey(address), 'confirmed'),
        { preferPrimary: false }
      );
      const data = info.value?.data as {
        parsed?: {
          type?: string;
          info?: {
            decimals?: number;
          };
        };
      } | Buffer | undefined;

      if (!info.value || info.value.owner.toBase58() !== TOKEN_PROGRAM_ID || !data || Buffer.isBuffer(data)) {
        this.mintValidationCache.set(address, {
          expiresAt: Date.now() + 15 * 60_000,
          value: false
        });
        return false;
      }

      const value = data.parsed?.type === 'mint' && typeof data.parsed.info?.decimals === 'number';
      this.mintValidationCache.set(address, {
        expiresAt: Date.now() + 15 * 60_000,
        value
      });
      return value;
    } catch (error: any) {
      logger.error('sniper_mint_validation_failed', {
        address,
        message: error.message
      });
      this.mintValidationCache.set(address, {
        expiresAt: Date.now() + 60_000,
        value: false
      });
      return false;
    }
  }

  private async isValidCreateMintCandidate(mint: string) {
    const cached = this.createCandidateCache.get(mint);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (!isResolvablePumpMint(mint)) {
      this.createCandidateCache.set(mint, {
        expiresAt: Date.now() + 15 * 60_000,
        value: false
      });
      return false;
    }

    const bondingCurve = deriveBondingCurveAddress(mint, config.pumpProgramId);
    const bondingCurveInfo = await rpcPool.withConnection(
      (connection) => connection.getAccountInfo(new PublicKey(bondingCurve), 'confirmed'),
      { preferPrimary: false }
    ).catch(() => null);

    const curveState = bondingCurveInfo?.data ? decodeBondingCurveCandidate(Buffer.from(bondingCurveInfo.data)) : null;
    if (!bondingCurveInfo?.data || bondingCurveInfo.owner.toBase58() !== config.pumpProgramId || !curveState) {
      this.createCandidateCache.set(mint, {
        expiresAt: Date.now() + 5 * 60_000,
        value: false
      });
      return false;
    }

    const value = await this.isTokenMint(mint);
    this.createCandidateCache.set(mint, {
      expiresAt: Date.now() + 15 * 60_000,
      value
    });
    return value;
  }

  private async fetchLaunchSnapshotWithRetry(
    mint: string,
    creatorWallet: string | null,
    bondingCurve: string,
    attempts = 8
  ) {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.fetchLaunchSnapshot(mint, creatorWallet, bondingCurve);
      } catch (error: any) {
        lastError = error;
        const retriableMessage = String(error?.message ?? '').toLowerCase();
        const retriable = retriableMessage.includes('missing')
          || retriableMessage.includes('not found')
          || retriableMessage.includes('invalid_bonding_curve_state')
          || retriableMessage.includes('account not found')
          || retriableMessage.includes('mint_not_ready');

        if (!retriable || attempt === attempts) {
          break;
        }

        logger.info('sniper_launch_snapshot_retry', {
          mint,
          attempt,
          attempts,
          message: error.message
        });
        
        // Exponential backoff: 1.5s, 3s, 6s, 12s, 24s...
        const delay = Math.min(30_000, 1000 * Math.pow(1.5, attempt));
        await wait(delay);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('launch_snapshot_unavailable');
  }

  private async fetchGlobalState() {
    const accountInfo = await rpcPool.withConnection(
      (connection) => connection.getAccountInfo(new PublicKey(PUMP_GLOBAL_ACCOUNT), 'confirmed')
    );

    if (!accountInfo?.data) {
      throw new Error('pump_global_account_missing');
    }

    return decodePumpGlobalState(Buffer.from(accountInfo.data));
  }

  private async fetchLaunchSnapshot(mint: string, creatorWallet: string | null, bondingCurve: string) {
    if (!isResolvablePumpMint(mint)) {
      throw new Error(`invalid_pump_mint:${mint}`);
    }

    // [DEBUG] bondingCurvePDA for diagnostic purposes
    logger.info('diagnostic_pda_check', { mint, bondingCurve });

    const curveInfo = await rpcPool.withConnection(
      (connection) => connection.getAccountInfo(new PublicKey(bondingCurve), 'confirmed')
    );
    const mintInfo = await rpcPool.withConnection(
      (connection) => connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed')
    );

    if (!curveInfo?.data) {
      throw new Error('bonding_curve_account_missing');
    }

    const curveData = Buffer.from(curveInfo.data);
    const curveState = decodeBondingCurveState(curveData);

    // [Readiness Check] Only block if migrated or completely uninitialized
    if (curveState.complete) {
      throw new Error('bonding_curve_complete');
    }
    if (curveState.virtualTokenReserves === 0n) {
      throw new Error('mint_not_ready');
    }

    logger.info('snapshot_raw_account_found', {
      mint,
      dataLength: curveData.length,
      dataHex: curveData.slice(0, 16).toString('hex')
    });

    const mintParsed = mintInfo.value?.data as {
      parsed?: {
        info?: {
          decimals?: number;
          mintAuthority?: string | null;
        };
      };
    } | undefined;

    // Use default decimals (6) if mint is not yet parsed by RPC
    const decimals = mintParsed?.parsed?.info?.decimals ?? 6;
    const mintAuthorityRevoked = !mintParsed?.parsed?.info?.mintAuthority;

    const creatorAccounts = creatorWallet
      ? await rpcPool.withConnection((connection) => connection.getParsedTokenAccountsByOwner(
        new PublicKey(creatorWallet),
        { mint: new PublicKey(mint) },
        'confirmed'
      ))
      : null;
    const largestAccounts = await rpcPool.withConnection(
      (connection) => connection.getTokenLargestAccounts(new PublicKey(mint), 'confirmed')
    );
    const walletReputation = creatorWallet
      ? await getWalletReputation(creatorWallet)
      : {
        wallet: '',
        label: 'unknown' as const,
        riskScore: 0,
        launchesSeen: 0,
        suspiciousEvents: 0,
        rugsSeen: 0
      };
    const dexMetadata = await this.fetchDexScreenerMetadata(mint);

    const creatorHoldingsRaw = creatorAccounts?.value?.reduce((sum, account) => {
      const parsed = account.account.data as {
        parsed?: {
          info?: {
            tokenAmount?: { amount?: string };
          };
        };
      };
      return sum + BigInt(parsed.parsed?.info?.tokenAmount?.amount ?? '0');
    }, 0n) ?? 0n;

    const holderOwners: Array<{ owner: string; amountRaw: bigint }> = [];
    for (const entry of largestAccounts.value.slice(0, 5)) {
      const parsed = await rpcPool.withConnection((connection) =>
        connection.getParsedAccountInfo(entry.address, 'confirmed')
      );
      const info = parsed.value?.data as {
        parsed?: {
          info?: {
            owner?: string;
            tokenAmount?: { amount?: string };
          };
        };
      } | undefined;
      holderOwners.push({
        owner: info?.parsed?.info?.owner ?? '',
        amountRaw: BigInt(entry.amount)
      });
    }

    const topHolderHoldingsRaw = holderOwners
      .filter((holder) => holder.owner && holder.owner !== bondingCurve)
      .sort((left, right) => Number(right.amountRaw - left.amountRaw))[0]?.amountRaw ?? 0n;

    return {
      curveState,
      decimals,
      mintAuthorityRevoked,
      creatorHoldingsRaw,
      topHolderHoldingsRaw,
      walletReputation,
      dexMetadata
    };
  }

  private async fetchDexScreenerMetadata(mint: string): Promise<DexScreenerMetadata | null> {
    if (!config.sniperEnableDexScreener) {
      return null;
    }

    try {
      const response = await fetchJson<{
        pairs?: Array<{
          pairAddress?: string;
          baseToken?: { symbol?: string };
          liquidity?: { usd?: number };
          info?: {
            socials?: Array<{ url?: string }>;
          };
        }>;
      }>(`${config.dexscreenerBaseUrl}/${mint}`, {
        timeoutMs: 7_500
      });

      const pair = response.pairs?.[0];
      if (!pair) {
        return null;
      }

      return {
        pairAddress: pair.pairAddress,
        symbol: pair.baseToken?.symbol,
        liquidityUsd: pair.liquidity?.usd,
        socials: pair.info?.socials?.map((item) => item.url).filter(Boolean) as string[] | undefined
      };
    } catch {
      return null;
    }
  }

  private async hasJupiterRoute(mint: string) {
    const params = new URLSearchParams({
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: String(ROUTE_PROBE_AMOUNT_LAMPORTS),
      slippageBps: '2000'
    });

    try {
      const response = await fetch(`${config.jupiterApiBaseUrl}/quote?${params.toString()}`, {
        headers: config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {}
      });
      if (response.ok) {
        const data = await response.json() as { outAmount?: string };
        return Number(data.outAmount ?? 0) > 0;
      }

      const body = await response.text().catch(() => '');
      if (response.status === 400 && isJupiterRouteUnavailableError(body)) {
        return false;
      }

      logger.info('sniper_jupiter_route_probe_failed', {
        mint,
        status: response.status,
        body: body.slice(0, 160)
      });
      return false;
    } catch (error: any) {
      logger.info('sniper_jupiter_route_probe_error', {
        mint,
        message: error.message
      });
      return false;
    }
  }

  private summarizeTrades(state: RuntimeLaunchState): LaunchStats {
    const windowStart = Date.now() - config.sniperMomentumWindowMs;
    const trades = state.trades.filter((trade) => trade.timestamp >= windowStart);
    const buys = trades.filter((trade) => trade.side === 'BUY');
    const sells = trades.filter((trade) => trade.side === 'SELL');
    const uniqueBuyers = new Set(buys.map((trade) => trade.actorWallet).filter(Boolean) as string[]).size;
    const buyVolumeSol = buys.reduce((sum, trade) => sum + (absoluteNumber(trade.solDeltaLamports) / LAMPORTS_PER_SOL), 0);
    const sellVolumeSol = sells.reduce((sum, trade) => sum + (absoluteNumber(trade.solDeltaLamports) / LAMPORTS_PER_SOL), 0);
    const midpoint = windowStart + Math.floor(config.sniperMomentumWindowMs / 2);
    const firstHalfBuys = buys.filter((trade) => trade.timestamp < midpoint).length;
    const secondHalfBuys = buys.filter((trade) => trade.timestamp >= midpoint).length;
    const firstHalfVolume = buys
      .filter((trade) => trade.timestamp < midpoint)
      .reduce((sum, trade) => sum + (absoluteNumber(trade.solDeltaLamports) / LAMPORTS_PER_SOL), 0);
    const secondHalfVolume = buys
      .filter((trade) => trade.timestamp >= midpoint)
      .reduce((sum, trade) => sum + (absoluteNumber(trade.solDeltaLamports) / LAMPORTS_PER_SOL), 0);

    return {
      buys: buys.length,
      sells: sells.length,
      uniqueBuyers,
      uniqueBuyerRatio: buys.length ? uniqueBuyers / buys.length : 0,
      buyVolumeSol,
      sellVolumeSol,
      buyAcceleration: firstHalfBuys === 0 ? secondHalfBuys : (secondHalfBuys - firstHalfBuys) / firstHalfBuys,
      volumeAcceleration: firstHalfVolume === 0 ? secondHalfVolume : (secondHalfVolume - firstHalfVolume) / firstHalfVolume,
      suspiciousWallets: 0,
      whaleExitCount: sells.filter((trade) => absoluteNumber(trade.solDeltaLamports) >= 500_000_000).length,
      buyBurstCount: buys.length
    };
  }

  private async handleLaunchDetected(params: {
    mint: string;
    signature: string;
    slot: number;
    tx: ParsedTransactionWithMeta;
    actorWallet: string | null;
  }) {
    if (this.launchStates.has(params.mint)) {
      return;
    }

    const creatorWallet = params.actorWallet;
    const bondingCurve = deriveBondingCurveAddress(params.mint, config.pumpProgramId);
    const launchSnapshot = await this.fetchLaunchSnapshotWithRetry(params.mint, creatorWallet, bondingCurve);
    const metrics = computeBondingCurveMetrics({
      curveState: launchSnapshot.curveState,
      globalState: this.globalState,
      decimals: launchSnapshot.decimals,
      creatorHoldingsRaw: launchSnapshot.creatorHoldingsRaw,
      topHolderHoldingsRaw: launchSnapshot.topHolderHoldingsRaw
    });

    const state: RuntimeLaunchState = {
      mint: params.mint,
      bondingCurve,
      creatorWallet,
      deployerWallet: params.actorWallet,
      signature: params.signature,
      slot: params.slot,
      detectedAt: Date.now(),
      curveState: launchSnapshot.curveState,
      mintDecimals: launchSnapshot.decimals,
      mintAuthorityRevoked: launchSnapshot.mintAuthorityRevoked,
      creatorHoldingsRaw: launchSnapshot.creatorHoldingsRaw,
      topHolderHoldingsRaw: launchSnapshot.topHolderHoldingsRaw,
      walletRiskLabel: launchSnapshot.walletReputation.label,
      walletRiskScore: launchSnapshot.walletReputation.riskScore,
      dexMetadata: launchSnapshot.dexMetadata,
      metrics,
      trades: [],
      buyActors: new Set<string>(),
      peakRealSolReserves: launchSnapshot.curveState.realSolReserves,
      decisionMade: false,
      decisionTimer: null,
      queuedExit: false,
      migrationSeen: false
    };

    this.launchStates.set(params.mint, state);
    this.subscribeCurve(params.mint, bondingCurve);
    incMetric('sniper.launch_detected');
    markSniperLaunchDetected(params.mint);
    logger.info('sniper_launch_detected', {
      mint: params.mint,
      signature: params.signature,
      creatorWallet,
      liquiditySol: metrics.liquiditySol,
      curveProgressPct: metrics.curveProgressPct,
      creatorHoldingsPct: metrics.creatorHoldingsPct,
      topHolderPct: metrics.topHolderPct
    });

    if (creatorWallet) {
      await touchWalletReputation({
        wallet: creatorWallet,
        launchesSeenDelta: 1,
        metadata: {
          mint: params.mint
        }
      });
    }

    await upsertSniperToken({
      mint: params.mint,
      bondingCurve,
      creatorWallet,
      deployerWallet: params.actorWallet,
      detectedSignature: params.signature,
      launchSlot: params.slot,
      status: 'DETECTED',
      decision: null,
      score: null,
      metrics,
      metadata: {
        symbol: launchSnapshot.dexMetadata?.symbol ?? null,
        pairAddress: launchSnapshot.dexMetadata?.pairAddress ?? null
      }
    });

    state.decisionTimer = setTimeout(() => {
      void this.finalizeDecision(params.mint).catch((error: any) => {
        logger.error('sniper_decision_finalize_failed', {
          mint: params.mint,
          message: error.message
        });
      });
    }, config.sniperWarmupMs);
  }

  private async handleTradeEvent(params: {
    mint: string;
    signature: string;
    slot: number;
    tx: ParsedTransactionWithMeta;
    actorWallet: string | null;
    eventKind: TradeEventKind;
  }) {
    const state = this.launchStates.get(params.mint);
    if (!state) {
      return;
    }

    if (params.eventKind === 'migrate') {
      state.migrationSeen = true;
      await updateSniperTokenStatus(params.mint, 'MIGRATED');
      return;
    }

    const flow = extractTradeFlow(params.tx, params.mint, params.actorWallet);
    const side = params.eventKind === 'buy' ? 'BUY' : 'SELL';

    if (side === 'BUY' && flow.actorWallet) {
      state.buyActors.add(flow.actorWallet);
    }

    state.trades.push({
      signature: params.signature,
      timestamp: Date.now(),
      actorWallet: flow.actorWallet,
      side,
      tokenDeltaRaw: flow.tokenDeltaRaw,
      solDeltaLamports: flow.solDeltaLamports
    });
    state.trades = state.trades.filter(
      (trade) => Date.now() - trade.timestamp <= config.sniperMomentumWindowMs * 2
    );

    await recordSniperEvent({
      signature: params.signature,
      mint: params.mint,
      eventType: side,
      actorWallet: flow.actorWallet,
      slot: params.slot,
      solAmountLamports: absoluteNumber(flow.solDeltaLamports),
      tokenAmountRaw: flow.tokenDeltaRaw < 0n ? -flow.tokenDeltaRaw : flow.tokenDeltaRaw,
      metadata: {
        creatorWallet: state.creatorWallet
      }
    });

    if (
      state.creatorWallet
      && flow.actorWallet === state.creatorWallet
      && side === 'SELL'
      && absoluteNumber(flow.solDeltaLamports) >= 250_000_000
    ) {
      state.walletRiskLabel = 'suspicious';
      state.walletRiskScore += 25;
      await touchWalletReputation({
        wallet: state.creatorWallet,
        suspiciousEventsDelta: 1,
        metadata: {
          mint: params.mint,
          reason: 'creator_early_sell'
        }
      });
    }

    await this.evaluateRiskExit(state);
  }

  private async finalizeDecision(mint: string) {
    const state = this.launchStates.get(mint);
    if (!state || state.decisionMade) {
      return;
    }

    const refreshed = await this.fetchLaunchSnapshot(mint, state.creatorWallet, state.bondingCurve)
      .catch(async (error: any) => {
        logger.error('sniper_launch_snapshot_refresh_failed', {
          mint,
          message: error.message
        });
        await updateSniperTokenStatus(mint, 'DETECTED', {
          decisionPending: true,
          reason: error.message
        }).catch(() => undefined);
        return null;
      });
    if (!refreshed) {
      return;
    }
    state.curveState = refreshed.curveState;
    state.mintDecimals = refreshed.decimals;
    state.mintAuthorityRevoked = refreshed.mintAuthorityRevoked;
    state.creatorHoldingsRaw = refreshed.creatorHoldingsRaw;
    state.topHolderHoldingsRaw = refreshed.topHolderHoldingsRaw;
    state.walletRiskLabel = refreshed.walletReputation.label;
    state.walletRiskScore = refreshed.walletReputation.riskScore;
    state.dexMetadata = refreshed.dexMetadata ?? state.dexMetadata;
    state.metrics = computeBondingCurveMetrics({
      curveState: refreshed.curveState,
      globalState: this.globalState,
      decimals: refreshed.decimals,
      creatorHoldingsRaw: refreshed.creatorHoldingsRaw,
      topHolderHoldingsRaw: refreshed.topHolderHoldingsRaw
    });

    const stats = this.summarizeTrades(state);
    stats.suspiciousWallets = await countSuspiciousWalletCluster([...state.buyActors]);

    const decision = decideLaunch({
      liquiditySol: state.metrics.liquiditySol,
      curveProgressPct: state.metrics.curveProgressPct,
      creatorHoldingsPct: state.metrics.creatorHoldingsPct,
      topHolderPct: state.metrics.topHolderPct,
      mintAuthorityRevoked: state.mintAuthorityRevoked,
      marketCapSol: state.metrics.marketCapSol,
      priceInSol: state.metrics.priceInSol,
      walletRiskLabel: state.walletRiskLabel,
      walletRiskScore: state.walletRiskScore,
      stats
    });

    state.decisionMade = true;
    incMetric(`sniper.decision.${decision.action.toLowerCase()}`);
    logger.info('sniper_decision', {
      mint,
      action: decision.action,
      score: decision.score,
      hardRejects: decision.hardRejects,
      reasons: decision.reasons,
      stats: {
        buys: stats.buys,
        sells: stats.sells,
        uniqueBuyers: stats.uniqueBuyers,
        buyVolumeSol: stats.buyVolumeSol,
        sellVolumeSol: stats.sellVolumeSol
      }
    });

    const jupiterRouteReady = decision.action === 'BUY'
      ? Boolean(state.dexMetadata?.pairAddress) && await this.hasJupiterRoute(mint)
      : false;

    if (decision.action === 'BUY' && !jupiterRouteReady) {
      await upsertSniperToken({
        mint,
        bondingCurve: state.bondingCurve,
        creatorWallet: state.creatorWallet,
        deployerWallet: state.deployerWallet,
        detectedSignature: state.signature,
        launchSlot: state.slot,
        status: 'SKIPPED',
        decision: 'jupiter_route_not_ready',
        score: decision.score,
        metrics: state.metrics,
        metadata: {
          decision: 'WAIT_FOR_ROUTE',
          reason: state.dexMetadata?.pairAddress
            ? 'Jupiter quote is not ready for this token yet.'
            : 'Jupiter cannot trade this pump.fun token until a DEX route exists.',
          hardRejects: decision.hardRejects,
          reasons: decision.reasons
        }
      });
      logger.info('sniper_buy_skipped_route_not_ready', {
        mint,
        score: decision.score,
        curveProgressPct: state.metrics.curveProgressPct,
        pairAddress: state.dexMetadata?.pairAddress ?? null
      });
      return;
    }

    if (decision.action === 'BUY') {
      const result = await enqueueSignal({
        signalKey: `pumpfun:${mint}:BUY:${state.detectedAt}`,
        mint,
        source: 'pumpfun',
        side: 'BUY',
        score: decision.score,
        payload: {
          symbol: normalizeSymbol(mint, state.dexMetadata?.symbol),
          detectedSignature: state.signature,
          bondingCurve: state.bondingCurve,
          creatorWallet: state.creatorWallet,
          liquiditySol: state.metrics.liquiditySol,
          marketCapSol: state.metrics.marketCapSol,
          priceInSol: state.metrics.priceInSol,
          curveProgressPct: state.metrics.curveProgressPct,
          creatorHoldingsPct: state.metrics.creatorHoldingsPct,
          topHolderPct: state.metrics.topHolderPct,
          walletRiskLabel: state.walletRiskLabel,
          walletRiskScore: state.walletRiskScore,
          buyCount: stats.buys,
          uniqueBuyers: stats.uniqueBuyers,
          buyVolumeSol: stats.buyVolumeSol,
          sellVolumeSol: stats.sellVolumeSol,
          hardRejects: decision.hardRejects,
          decisionReasons: decision.reasons,
          priorityLevel: decision.priorityLevel,
          recommendedSlippageBps: decision.recommendedSlippageBps,
          recommendedPriorityFeeLamports: decision.recommendedPriorityFeeLamports,
          dexScreener: state.dexMetadata
        }
      });
      logger.info('sniper_signal_result', {
        mint,
        signalId: result.signalId,
        queued: result.queued,
        score: decision.score
      });

      await upsertSniperToken({
        mint,
        bondingCurve: state.bondingCurve,
        creatorWallet: state.creatorWallet,
        deployerWallet: state.deployerWallet,
        detectedSignature: state.signature,
        launchSlot: state.slot,
        status: result.queued > 0 ? 'QUEUED' : 'NO_MATCH',
        decision: decision.reasons.join(', '),
        score: decision.score,
        metrics: state.metrics,
        metadata: {
          decision: decision.action,
          hardRejects: decision.hardRejects,
          reasons: decision.reasons
        }
      });
      if (result.queued > 0) {
        markSniperSignalQueued(mint);
      }
      return;
    }

    await upsertSniperToken({
      mint,
      bondingCurve: state.bondingCurve,
      creatorWallet: state.creatorWallet,
      deployerWallet: state.deployerWallet,
      detectedSignature: state.signature,
      launchSlot: state.slot,
      status: 'SKIPPED',
      decision: decision.hardRejects.join(', '),
      score: decision.score,
      metrics: state.metrics,
      metadata: {
        decision: decision.action,
        hardRejects: decision.hardRejects,
        reasons: decision.reasons
      }
    });
  }

  private async evaluateRiskExit(state: RuntimeLaunchState) {
    if (!state.decisionMade || state.queuedExit || !state.curveState) {
      return;
    }

    const stats = this.summarizeTrades(state);
    const liquidityDropPct = state.peakRealSolReserves > 0n
      ? 100 - Number((state.curveState.realSolReserves * 100n) / state.peakRealSolReserves)
      : 0;

    if (liquidityDropPct >= 40) {
      await this.queueRiskExit(state, 'bonding_curve_weakness', {
        liquidityDropPct
      });
      return;
    }

    if (stats.sells >= Math.max(3, stats.buys) && stats.sellVolumeSol > stats.buyVolumeSol * 1.25) {
      await this.queueRiskExit(state, 'heavy_sell_pressure', {
        sellVolumeSol: stats.sellVolumeSol,
        buyVolumeSol: stats.buyVolumeSol
      });
      return;
    }

    if (stats.whaleExitCount > 0 && stats.sellVolumeSol > 2) {
      await this.queueRiskExit(state, 'rapid_whale_exits', {
        whaleExitCount: stats.whaleExitCount
      });
      return;
    }

    if (state.walletRiskLabel === 'high_risk') {
      await this.queueRiskExit(state, 'suspicious_wallet_behavior', {
        walletRiskScore: state.walletRiskScore
      });
    }
  }

  private async queueRiskExit(
    state: RuntimeLaunchState,
    reason: string,
    metadata: Record<string, unknown>
  ) {
    const queued = await enqueueRiskExitForMint({
      mint: state.mint,
      source: 'sniper_auto_exit',
      reason,
      metadata
    });

    if (queued > 0) {
      state.queuedExit = true;
      await updateSniperTokenStatus(state.mint, 'EXIT_QUEUED', {
        exitReason: reason,
        ...metadata
      });
      incMetric('sniper.exit_queued');
    }
  }

  private pruneProcessedSignatures() {
    const now = Date.now();
    for (const [signature, timestamp] of this.processedSignatures.entries()) {
      if (now - timestamp > config.sniperProcessedSignatureTtlMs) {
        this.processedSignatures.delete(signature);
      }
    }
  }

  private pruneLaunchStates() {
    if (this.launchStates.size <= config.sniperMaxTrackedTokens) {
      return;
    }

    const removable = [...this.launchStates.values()]
      .filter((state) => state.decisionMade)
      .sort((left, right) => left.detectedAt - right.detectedAt);

    while (this.launchStates.size > config.sniperMaxTrackedTokens && removable.length) {
      const next = removable.shift();
      if (!next) {
        break;
      }
      if (next.decisionTimer) {
        clearTimeout(next.decisionTimer);
      }
      this.launchStates.delete(next.mint);
    }
  }
}
