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
  extractTradeFlow,
  getPumpEventKindFromLogs,
  LAMPORTS_PER_SOL,
  PUMP_GLOBAL_ACCOUNT,
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

export class SniperService {
  private readonly websocketUrls = [config.heliusWsUrl, config.alchemyWsUrl].filter(Boolean);
  private ws: WebSocket | null = null;
  private wsIndex = 0;
  private reconnectAttempts = 0;
  private lastMessageAt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private requestId = 1;
  private readonly pendingRequests = new Map<number, SubscriptionRequest>();
  private readonly accountSubscriptions = new Map<number, { mint: string; bondingCurve: string }>();
  private readonly launchStates = new Map<string, RuntimeLaunchState>();
  private readonly processedSignatures = new Map<string, number>();
  private globalState: PumpGlobalState | null = null;
  private logsSubscriptionId: number | null = null;
  private stopping = false;

  async start() {
    if (!this.websocketUrls.length) {
      throw new Error('HELIUS_WS_URL_or_ALCHEMY_WS_URL_required');
    }

    this.globalState = await this.fetchGlobalState().catch((error: any) => {
      logger.error('sniper_global_state_load_failed', { message: error.message });
      return null;
    });

    await this.connect();
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
        this.logsSubscriptionId = typeof payload.result === 'number' ? payload.result : null;
      } else if (request.type === 'account' && typeof payload.result === 'number') {
        this.accountSubscriptions.set(payload.result, {
          mint: request.mint,
          bondingCurve: request.bondingCurve
        });
      }
      return;
    }

    if (payload.method === 'logsNotification') {
      await this.handleLogNotification(payload as LogNotification).catch((error: any) => {
        logger.error('sniper_log_notification_error', { message: error.message });
      });
      return;
    }

    if (payload.method === 'accountNotification') {
      await this.handleAccountNotification(payload as AccountNotification).catch((error: any) => {
        logger.error('sniper_account_notification_error', { message: error.message });
      });
    }
  }

  private async handleLogNotification(payload: LogNotification) {
    const signature = payload.params?.result?.value?.signature;
    const logs = payload.params?.result?.value?.logs ?? [];
    const slot = payload.params?.result?.context?.slot ?? 0;

    if (!signature || !logs.length) {
      return;
    }

    if (this.processedSignatures.has(signature)) {
      return;
    }
    this.processedSignatures.set(signature, Date.now());

    const eventKind = getPumpEventKindFromLogs(logs);
    if (eventKind === 'unknown') {
      return;
    }

    const tx = await this.fetchParsedTransaction(signature);
    if (!tx) {
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
    return rpcPool.withConnection(
      (connection) => connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      }),
      {
        preferPrimary: false,
        timeoutMs: config.rpcRequestTimeoutMs
      }
    );
  }

  private async resolveMint(tx: ParsedTransactionWithMeta, eventKind: PumpEventKind) {
    const direct = extractMintFromParsedTransaction(tx, eventKind);
    if (direct) {
      return direct;
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

    return candidates[0] ?? null;
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
    const [curveInfo, mintInfo, creatorAccounts, largestAccounts, walletReputation, dexMetadata] = await Promise.all([
      rpcPool.withConnection((connection) => connection.getAccountInfo(new PublicKey(bondingCurve), 'confirmed')),
      rpcPool.withConnection((connection) => connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed')),
      creatorWallet
        ? rpcPool.withConnection((connection) => connection.getParsedTokenAccountsByOwner(
          new PublicKey(creatorWallet),
          { mint: new PublicKey(mint) },
          'confirmed'
        ))
        : Promise.resolve(null),
      rpcPool.withConnection((connection) => connection.getTokenLargestAccounts(new PublicKey(mint), 'confirmed')),
      creatorWallet ? getWalletReputation(creatorWallet) : Promise.resolve({
        wallet: '',
        label: 'unknown' as const,
        riskScore: 0,
        launchesSeen: 0,
        suspiciousEvents: 0,
        rugsSeen: 0
      }),
      this.fetchDexScreenerMetadata(mint)
    ]);

    if (!curveInfo?.data) {
      throw new Error('bonding_curve_account_missing');
    }

    const curveState = decodeBondingCurveState(Buffer.from(curveInfo.data));
    const mintParsed = mintInfo.value?.data as {
      parsed?: {
        info?: {
          decimals?: number;
          mintAuthority?: string | null;
        };
      };
    } | undefined;

    const decimals = mintParsed?.parsed?.info?.decimals ?? 6;
    const mintAuthorityRevoked = !mintParsed?.parsed?.info?.mintAuthority;
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

    const holderOwners = await Promise.all(
      largestAccounts.value.slice(0, 10).map(async (entry) => {
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
        return {
          owner: info?.parsed?.info?.owner ?? '',
          amountRaw: BigInt(entry.amount)
        };
      })
    );

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
    const launchSnapshot = await this.fetchLaunchSnapshot(params.mint, creatorWallet, bondingCurve);
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
      void this.finalizeDecision(params.mint);
    }, config.sniperWarmupMs);
  }

  private async handleTradeEvent(params: {
    mint: string;
    signature: string;
    slot: number;
    tx: ParsedTransactionWithMeta;
    actorWallet: string | null;
    eventKind: 'buy' | 'sell' | 'migrate';
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

    const refreshed = await this.fetchLaunchSnapshot(mint, state.creatorWallet, state.bondingCurve);
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
