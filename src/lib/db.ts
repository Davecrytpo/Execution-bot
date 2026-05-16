import { Pool, type PoolConfig, type QueryResultRow } from 'pg';
import { config } from '../config.js';

function parseBoolean(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`invalid_boolean_config:${value}`);
}

export function resolveDatabaseSsl(
  databaseUrl: string,
  overrides?: {
    databaseSsl?: string;
    databaseSslRejectUnauthorized?: string;
  }
): PoolConfig['ssl'] {
  const explicitSsl = parseBoolean(overrides?.databaseSsl ?? process.env.DATABASE_SSL);
  const explicitRejectUnauthorized = parseBoolean(
    overrides?.databaseSslRejectUnauthorized ?? process.env.DATABASE_SSL_REJECT_UNAUTHORIZED
  );

  const isSupabaseUrl = /supabase\.co/i.test(databaseUrl);
  const sslMode = databaseUrl.match(/[?&]sslmode=([^&]+)/i)?.[1]?.toLowerCase();
  const sslRequiredByUrl = sslMode !== undefined && sslMode !== 'disable';
  const defaultRejectUnauthorized = explicitRejectUnauthorized ?? !isSupabaseUrl;

  if (explicitSsl === false || sslMode === 'disable') {
    return undefined;
  }

  if (explicitSsl === true || sslRequiredByUrl || isSupabaseUrl) {
    return { rejectUnauthorized: defaultRejectUnauthorized };
  }

  return undefined;
}

export function normalizeDatabaseUrl(databaseUrl: string) {
  try {
    const parsed = new URL(databaseUrl);
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('uselibpqcompat');
    return parsed.toString();
  } catch {
    return databaseUrl;
  }
}

export const pool = new Pool({
  connectionString: normalizeDatabaseUrl(config.databaseUrl),
  ssl: resolveDatabaseSsl(config.databaseUrl)
});

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return pool.query<T>(text, params);
}
