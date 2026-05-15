import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const PUMP_GLOBAL_ACCOUNT = '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf';
export const LAMPORTS_PER_SOL = 1_000_000_000;

export type PumpEventKind = 'create' | 'buy' | 'sell' | 'migrate' | 'unknown';

export type BondingCurveState = {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  discriminatorOffset: number;
  rawLength: number;
};

export type PumpGlobalState = {
  initialVirtualTokenReserves: bigint;
  initialVirtualSolReserves: bigint;
  initialRealTokenReserves: bigint;
  tokenTotalSupply: bigint;
  feeBasisPoints: bigint;
  enableMigrate: boolean;
};

export type BondingCurveMetrics = {
  priceInSol: number;
  marketCapSol: number;
  liquiditySol: number;
  curveProgressPct: number;
  creatorHoldingsPct: number;
  topHolderPct: number;
};

export type TradeFlow = {
  actorWallet: string | null;
  tokenDeltaRaw: bigint;
  solDeltaLamports: number;
};

function readBigIntLE(buffer: Buffer, offset: number) {
  return buffer.readBigUInt64LE(offset);
}

function absoluteBigInt(value: bigint) {
  return value < 0n ? -value : value;
}

function normalizeAccountKey(key: unknown): string {
  if (!key) {
    return '';
  }
  if (typeof key === 'string') {
    return key;
  }
  if (typeof key === 'object' && 'pubkey' in key) {
    const pubkey = (key as { pubkey: string | PublicKey }).pubkey;
    return typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
  }
  if (key instanceof PublicKey) {
    return key.toBase58();
  }
  return String(key);
}

function tokenAmountRaw(entry: { uiTokenAmount?: { amount?: string } }) {
  return BigInt(entry.uiTokenAmount?.amount ?? '0');
}

function aggregateTokenDeltas(tx: ParsedTransactionWithMeta) {
  const aggregate = new Map<string, bigint>();
  const preByKey = new Map<string, bigint>();

  for (const entry of tx.meta?.preTokenBalances ?? []) {
    preByKey.set(`${entry.accountIndex}:${entry.mint}:${entry.owner ?? ''}`, tokenAmountRaw(entry));
  }

  const seenKeys = new Set<string>();
  for (const entry of tx.meta?.postTokenBalances ?? []) {
    const key = `${entry.accountIndex}:${entry.mint}:${entry.owner ?? ''}`;
    const preAmount = preByKey.get(key) ?? 0n;
    const postAmount = tokenAmountRaw(entry);
    aggregate.set(entry.mint, (aggregate.get(entry.mint) ?? 0n) + (postAmount - preAmount));
    seenKeys.add(key);
  }

  for (const entry of tx.meta?.preTokenBalances ?? []) {
    const key = `${entry.accountIndex}:${entry.mint}:${entry.owner ?? ''}`;
    if (seenKeys.has(key)) {
      continue;
    }
    const preAmount = tokenAmountRaw(entry);
    aggregate.set(entry.mint, (aggregate.get(entry.mint) ?? 0n) - preAmount);
  }

  return aggregate;
}

function clampPercentage(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

export function deriveBondingCurveAddress(mint: string, programId: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(programId)
  )[0].toBase58();
}

export function getPumpEventKindFromLogs(logs: string[]) {
  const joined = logs.join('\n').toLowerCase();
  if (joined.includes('instruction: create')) {
    return 'create';
  }
  if (joined.includes('instruction: buy')) {
    return 'buy';
  }
  if (joined.includes('instruction: sell')) {
    return 'sell';
  }
  if (joined.includes('instruction: migrate')) {
    return 'migrate';
  }
  return 'unknown';
}

export function decodeBondingCurveState(data: Buffer): BondingCurveState {
  const offsets = [8, 0];

  for (const offset of offsets) {
    if (data.length < offset + 41) {
      continue;
    }

    const state = {
      virtualTokenReserves: readBigIntLE(data, offset),
      virtualSolReserves: readBigIntLE(data, offset + 8),
      realTokenReserves: readBigIntLE(data, offset + 16),
      realSolReserves: readBigIntLE(data, offset + 24),
      tokenTotalSupply: readBigIntLE(data, offset + 32),
      complete: data[offset + 40] === 1,
      discriminatorOffset: offset,
      rawLength: data.length
    };

    if (
      state.virtualTokenReserves > 0n
      && state.virtualSolReserves > 0n
      && state.tokenTotalSupply > 0n
    ) {
      return state;
    }
  }

  throw new Error('invalid_bonding_curve_state');
}

export function decodePumpGlobalState(data: Buffer): PumpGlobalState {
  const offsets = [8, 0];

  for (const offset of offsets) {
    if (data.length < offset + 131) {
      continue;
    }

    let cursor = offset;
    cursor += 1; // initialized
    cursor += 32; // authority
    cursor += 32; // fee_recipient

    const initialVirtualTokenReserves = readBigIntLE(data, cursor);
    cursor += 8;
    const initialVirtualSolReserves = readBigIntLE(data, cursor);
    cursor += 8;
    const initialRealTokenReserves = readBigIntLE(data, cursor);
    cursor += 8;
    const tokenTotalSupply = readBigIntLE(data, cursor);
    cursor += 8;
    const feeBasisPoints = readBigIntLE(data, cursor);
    cursor += 8;
    cursor += 32; // withdraw_authority
    const enableMigrate = data[cursor] === 1;

    if (
      initialVirtualTokenReserves > 0n
      && initialVirtualSolReserves > 0n
      && initialRealTokenReserves > 0n
      && tokenTotalSupply > 0n
    ) {
      return {
        initialVirtualTokenReserves,
        initialVirtualSolReserves,
        initialRealTokenReserves,
        tokenTotalSupply,
        feeBasisPoints,
        enableMigrate
      };
    }
  }

  throw new Error('invalid_pump_global_state');
}

export function extractMintFromParsedTransaction(
  tx: ParsedTransactionWithMeta,
  eventKind: PumpEventKind
) {
  const balances = aggregateTokenDeltas(tx);
  const entries = [...balances.entries()].filter(([mint]) => mint !== SOL_MINT);

  if (entries.length === 1) {
    return entries[0][0];
  }

  if (eventKind === 'buy') {
    return entries
      .filter(([, delta]) => delta > 0n)
      .sort((left, right) => Number(absoluteBigInt(right[1]) - absoluteBigInt(left[1])))[0]?.[0]
      ?? null;
  }

  if (eventKind === 'sell') {
    return entries
      .filter(([, delta]) => delta < 0n)
      .sort((left, right) => Number(absoluteBigInt(right[1]) - absoluteBigInt(left[1])))[0]?.[0]
      ?? null;
  }

  if (eventKind === 'create') {
    const postMints = (tx.meta?.postTokenBalances ?? [])
      .map((entry) => entry.mint)
      .filter((mint) => mint !== SOL_MINT);
    return postMints[0] ?? entries[0]?.[0] ?? null;
  }

  return entries[0]?.[0] ?? null;
}

export function extractActorFromParsedTransaction(tx: ParsedTransactionWithMeta) {
  const signer = tx.transaction.message.accountKeys.find((key) => key.signer);
  return signer ? normalizeAccountKey(signer) : null;
}

export function extractTradeFlow(
  tx: ParsedTransactionWithMeta,
  mint: string,
  fallbackActor?: string | null
): TradeFlow {
  const actorWallet = fallbackActor ?? extractActorFromParsedTransaction(tx);
  const preTokenBalances = tx.meta?.preTokenBalances ?? [];
  const postTokenBalances = tx.meta?.postTokenBalances ?? [];
  const tokenDeltaByOwner = new Map<string, bigint>();

  const preByKey = new Map<string, bigint>();
  for (const entry of preTokenBalances) {
    if (entry.mint !== mint || !entry.owner) {
      continue;
    }
    preByKey.set(`${entry.accountIndex}:${entry.owner}`, tokenAmountRaw(entry));
  }

  const seen = new Set<string>();
  for (const entry of postTokenBalances) {
    if (entry.mint !== mint || !entry.owner) {
      continue;
    }
    const key = `${entry.accountIndex}:${entry.owner}`;
    const preAmount = preByKey.get(key) ?? 0n;
    const postAmount = tokenAmountRaw(entry);
    tokenDeltaByOwner.set(entry.owner, (tokenDeltaByOwner.get(entry.owner) ?? 0n) + (postAmount - preAmount));
    seen.add(key);
  }

  for (const entry of preTokenBalances) {
    if (entry.mint !== mint || !entry.owner) {
      continue;
    }
    const key = `${entry.accountIndex}:${entry.owner}`;
    if (seen.has(key)) {
      continue;
    }
    tokenDeltaByOwner.set(entry.owner, (tokenDeltaByOwner.get(entry.owner) ?? 0n) - tokenAmountRaw(entry));
  }

  const resolvedActor = actorWallet
    ?? [...tokenDeltaByOwner.entries()]
      .sort((left, right) => Number(absoluteBigInt(right[1]) - absoluteBigInt(left[1])))[0]?.[0]
    ?? null;

  const actorIndex = tx.transaction.message.accountKeys.findIndex(
    (key) => normalizeAccountKey(key) === resolvedActor
  );

  const preLamports = actorIndex >= 0 ? tx.meta?.preBalances?.[actorIndex] ?? 0 : 0;
  const postLamports = actorIndex >= 0 ? tx.meta?.postBalances?.[actorIndex] ?? 0 : 0;

  return {
    actorWallet: resolvedActor,
    tokenDeltaRaw: resolvedActor ? tokenDeltaByOwner.get(resolvedActor) ?? 0n : 0n,
    solDeltaLamports: postLamports - preLamports
  };
}

export function computeBondingCurveMetrics(params: {
  curveState: BondingCurveState;
  globalState: PumpGlobalState | null;
  decimals: number;
  creatorHoldingsRaw: bigint;
  topHolderHoldingsRaw: bigint;
}) {
  const {
    curveState,
    globalState,
    decimals,
    creatorHoldingsRaw,
    topHolderHoldingsRaw
  } = params;

  const tokenDivisor = 10 ** decimals;
  const totalSupplyRaw = Number(globalState?.tokenTotalSupply ?? curveState.tokenTotalSupply);
  const initialRealTokenReservesRaw = Number(
    globalState?.initialRealTokenReserves ?? curveState.tokenTotalSupply
  );
  const virtualSol = Number(curveState.virtualSolReserves) / LAMPORTS_PER_SOL;
  const virtualTokens = Number(curveState.virtualTokenReserves) / tokenDivisor;
  const priceInSol = virtualTokens > 0 ? virtualSol / virtualTokens : 0;
  const marketCapSol = priceInSol * (totalSupplyRaw / tokenDivisor);
  const liquiditySol = Number(curveState.realSolReserves) / LAMPORTS_PER_SOL;
  const curveProgressPct = initialRealTokenReservesRaw > 0
    ? 100 - ((Number(curveState.realTokenReserves) / initialRealTokenReservesRaw) * 100)
    : 0;

  return {
    priceInSol,
    marketCapSol,
    liquiditySol,
    curveProgressPct: clampPercentage(curveProgressPct),
    creatorHoldingsPct: totalSupplyRaw > 0 ? clampPercentage((Number(creatorHoldingsRaw) / totalSupplyRaw) * 100) : 0,
    topHolderPct: totalSupplyRaw > 0 ? clampPercentage((Number(topHolderHoldingsRaw) / totalSupplyRaw) * 100) : 0
  } satisfies BondingCurveMetrics;
}
