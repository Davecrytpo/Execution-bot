import {
  Connection,
  type Commitment,
  type RpcResponseAndContext,
  type SendOptions,
  type SignatureResult
} from '@solana/web3.js';
import { config } from '../config.js';
import { logger } from './logger.js';
import { fetchJson } from './http.js';

type RpcEndpointName = 'primary' | 'gatekeeper' | 'backup';

type RpcEndpoint = {
  name: RpcEndpointName;
  url: string;
  rank: number;
  connection: Connection;
};

export type RpcEndpointHealth = {
  name: RpcEndpointName;
  url: string;
  slot: number | null;
  lag: number | null;
  reachable: boolean;
  error?: string;
};

export type RpcStatus = {
  checkedAt: string;
  preferred: RpcEndpointName | null;
  bestSlot: number | null;
  endpoints: RpcEndpointHealth[];
};

function uniqueEndpoints(endpoints: Array<Omit<RpcEndpoint, 'connection'>>) {
  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    if (!endpoint.url || seen.has(endpoint.url)) {
      return false;
    }
    seen.add(endpoint.url);
    return true;
  });
}

function buildEndpoints(): RpcEndpoint[] {
  return uniqueEndpoints([
    { name: 'primary', url: config.heliusRpcUrl, rank: 0 },
    { name: 'gatekeeper', url: config.heliusGatekeeperRpcUrl, rank: 1 },
    { name: 'backup', url: config.alchemyRpcUrl, rank: 2 }
  ]).map((endpoint) => ({
    ...endpoint,
    connection: new Connection(endpoint.url, 'confirmed')
  }));
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class RpcPool {
  private readonly endpoints = buildEndpoints();
  private slotCache: { expiresAt: number; status: RpcStatus } | null = null;
  private lastPreferredEndpoint: RpcEndpointName | null = null;
  private readonly endpointCooldownUntil = new Map<RpcEndpointName, number>();
  private readonly endpointErrorLogUntil = new Map<string, number>();

  getPrimaryConnection() {
    return this.endpoints[0]?.connection ?? new Connection(config.solanaRpc, 'confirmed');
  }

  private getEndpointRank(name: RpcEndpointName) {
    return this.endpoints.find((endpoint) => endpoint.name === name)?.rank ?? Number.MAX_SAFE_INTEGER;
  }

  private getEndpointByName(name: RpcEndpointName) {
    return this.endpoints.find((endpoint) => endpoint.name === name) ?? null;
  }

  private isEndpointCoolingDown(name: RpcEndpointName) {
    return (this.endpointCooldownUntil.get(name) ?? 0) > Date.now();
  }

  private markEndpointFailure(endpoint: RpcEndpoint, message: string) {
    this.endpointCooldownUntil.set(endpoint.name, Date.now() + config.rpcEndpointCooldownMs);

    const key = `${endpoint.name}:${message}`;
    const nextAllowedLogAt = this.endpointErrorLogUntil.get(key) ?? 0;
    if (Date.now() < nextAllowedLogAt) {
      return;
    }

    this.endpointErrorLogUntil.set(key, Date.now() + config.rpcErrorLogCooldownMs);
    logger.error('rpc_operation_failed', {
      endpoint: endpoint.name,
      message
    });
  }

  private clearEndpointFailure(endpoint: RpcEndpoint) {
    this.endpointCooldownUntil.delete(endpoint.name);
  }

  private async probeEndpoint(endpoint: RpcEndpoint): Promise<RpcEndpointHealth> {
    try {
      const slot = await withTimeout(
        endpoint.connection.getSlot('processed'),
        config.rpcRequestTimeoutMs,
        `${endpoint.name}:getSlot`
      );
      return {
        name: endpoint.name,
        url: endpoint.url,
        slot,
        lag: null,
        reachable: true
      };
    } catch (error: any) {
      return {
        name: endpoint.name,
        url: endpoint.url,
        slot: null,
        lag: null,
        reachable: false,
        error: error.message
      };
    }
  }

  async getStatus(force = false): Promise<RpcStatus> {
    const now = Date.now();
    if (!force && this.slotCache && this.slotCache.expiresAt > now) {
      return this.slotCache.status;
    }

    const probed = await Promise.all(this.endpoints.map((endpoint) => this.probeEndpoint(endpoint)));
    const availableSlots = probed
      .map((endpoint) => endpoint.slot)
      .filter((slot): slot is number => slot !== null);
    const bestSlot = availableSlots.length ? Math.max(...availableSlots) : null;

    const endpoints = probed.map((endpoint) => ({
      ...endpoint,
      lag: endpoint.slot === null || bestSlot === null ? null : Math.max(0, bestSlot - endpoint.slot)
    }));

    const primary = endpoints.find((endpoint) => endpoint.name === 'primary');
    let preferred: RpcEndpointName | null = null;

    if (primary && primary.slot !== null && (primary.lag ?? 0) <= config.rpcSlotLagThreshold) {
      preferred = 'primary';
    } else {
      preferred = endpoints
        .filter((endpoint) => endpoint.slot !== null)
        .sort((left, right) => {
          const lagDiff = (left.lag ?? Number.MAX_SAFE_INTEGER) - (right.lag ?? Number.MAX_SAFE_INTEGER);
          if (lagDiff !== 0) {
            return lagDiff;
          }
          return this.getEndpointRank(left.name) - this.getEndpointRank(right.name);
        })[0]?.name ?? null;
    }

    if (preferred && preferred !== this.lastPreferredEndpoint) {
      logger.info('rpc_failover_state_changed', {
        previous: this.lastPreferredEndpoint,
        current: preferred,
        bestSlot,
        endpoints
      });
      this.lastPreferredEndpoint = preferred;
    }

    const status = {
      checkedAt: new Date(now).toISOString(),
      preferred,
      bestSlot,
      endpoints
    };

    this.slotCache = {
      expiresAt: now + config.rpcHealthCacheMs,
      status
    };

    return status;
  }

  private async getOrderedEndpoints(preferPrimary: boolean) {
    const status = await this.getStatus();
    const healthByName = new Map(status.endpoints.map((endpoint) => [endpoint.name, endpoint]));
    const reachable = this.endpoints.filter((endpoint) => healthByName.get(endpoint.name)?.slot !== null);
    const available = reachable.filter((endpoint) => !this.isEndpointCoolingDown(endpoint.name));

    if (!available.length && !reachable.length) {
      return this.endpoints;
    }

    const candidateEndpoints = available.length ? available : reachable;

    if (preferPrimary) {
      const primaryHealth = healthByName.get('primary');
      const primaryEndpoint = this.getEndpointByName('primary');
      if (
        primaryEndpoint
        && !this.isEndpointCoolingDown('primary')
        && primaryHealth
        && primaryHealth.slot !== null
        && (primaryHealth.lag ?? 0) <= config.rpcSlotLagThreshold
      ) {
        return [
          primaryEndpoint,
          ...candidateEndpoints
            .filter((endpoint) => endpoint.name !== 'primary')
            .sort((left, right) => {
              const leftLag = healthByName.get(left.name)?.lag ?? Number.MAX_SAFE_INTEGER;
              const rightLag = healthByName.get(right.name)?.lag ?? Number.MAX_SAFE_INTEGER;
              if (leftLag !== rightLag) {
                return leftLag - rightLag;
              }
              return left.rank - right.rank;
            })
        ];
      }
    }

    return candidateEndpoints.sort((left, right) => {
      const leftLag = healthByName.get(left.name)?.lag ?? Number.MAX_SAFE_INTEGER;
      const rightLag = healthByName.get(right.name)?.lag ?? Number.MAX_SAFE_INTEGER;
      if (leftLag !== rightLag) {
        return leftLag - rightLag;
      }
      return left.rank - right.rank;
    });
  }

  async withConnection<T>(
    fn: (connection: Connection, endpoint: RpcEndpoint) => Promise<T>,
    options: { preferPrimary?: boolean; timeoutMs?: number } = {}
  ): Promise<T> {
    const ordered = await this.getOrderedEndpoints(options.preferPrimary ?? true);
    const errors: string[] = [];

    for (const endpoint of ordered) {
      try {
        const result = await withTimeout(
          fn(endpoint.connection, endpoint),
          options.timeoutMs ?? config.rpcRequestTimeoutMs,
          `${endpoint.name}:operation`
        );
        this.clearEndpointFailure(endpoint);
        return result;
      } catch (error: any) {
        errors.push(`${endpoint.name}:${error.message}`);
        this.markEndpointFailure(endpoint, error.message);
      }
    }

    throw new Error(`rpc_all_failed:${errors.join('|')}`);
  }

  async sendRawTransactionRace(rawTransaction: Uint8Array, options: SendOptions) {
    const endpoints = (await this.getOrderedEndpoints(false)).slice(0, 3);
    if (!endpoints.length) {
      throw new Error('rpc_send_no_endpoints');
    }

    const attempts = endpoints.map((endpoint) =>
      withTimeout(
        endpoint.connection.sendRawTransaction(rawTransaction, options),
        config.rpcRequestTimeoutMs,
        `${endpoint.name}:sendRawTransaction`
      ).then((signature) => ({
        signature,
        endpoint: endpoint.name
      }))
    );

    try {
      return await Promise.any(attempts);
    } catch (error: any) {
      const messages = error instanceof AggregateError
        ? error.errors.map((entry: any) => entry?.message ?? String(entry))
        : [error.message];
      throw new Error(`rpc_send_failed:${messages.join('|')}`);
    }
  }

  async confirmSignature(
    signature: string,
    commitment: Commitment = 'confirmed'
  ): Promise<RpcResponseAndContext<SignatureResult>> {
    return this.withConnection(
      (connection) => connection.confirmTransaction(signature, commitment),
      {
        preferPrimary: false,
        timeoutMs: config.txConfirmationTimeoutMs
      }
    );
  }

  private async performJsonRpc<T>(
    endpoint: RpcEndpoint,
    method: string,
    params: unknown[],
    timeoutMs = config.rpcRequestTimeoutMs
  ): Promise<T> {
    const response = await fetchJson<{
      result?: T;
      error?: { message?: string };
    }>(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params
      }),
      timeoutMs
    });

    if (response.error) {
      throw new Error(response.error.message ?? `${method}_failed`);
    }

    if (response.result === undefined) {
      throw new Error(`${method}_missing_result`);
    }

    return response.result;
  }

  async jsonRpcRequest<T>(
    method: string,
    params: unknown[] = [],
    options: {
      preferPrimary?: boolean;
      endpointName?: RpcEndpointName;
      timeoutMs?: number;
    } = {}
  ): Promise<T> {
    if (options.endpointName) {
      const endpoint = this.getEndpointByName(options.endpointName);
      if (!endpoint) {
        throw new Error(`rpc_endpoint_not_found:${options.endpointName}`);
      }
      return this.performJsonRpc(endpoint, method, params, options.timeoutMs);
    }

    const ordered = await this.getOrderedEndpoints(options.preferPrimary ?? true);
    const errors: string[] = [];

    for (const endpoint of ordered) {
      try {
        return await this.performJsonRpc(endpoint, method, params, options.timeoutMs);
      } catch (error: any) {
        errors.push(`${endpoint.name}:${error.message}`);
      }
    }

    throw new Error(`rpc_json_failed:${method}:${errors.join('|')}`);
  }
}

export const rpcPool = new RpcPool();
