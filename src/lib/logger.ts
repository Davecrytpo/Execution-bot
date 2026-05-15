const SENSITIVE_KEY_PATTERN = /(api[-_]?key|token|secret|password|authorization|connectionstring|dsn)/i;
const SENSITIVE_QUERY_KEY_PATTERN = /^(api[-_]?key|token|secret|password|authorization|access_token)$/i;

function sanitizeString(value: string) {
  let sanitized = value.replace(
    /((?:api[-_]?key|token|secret|password|authorization|access_token)=)([^&\s]+)/ig,
    '$1***'
  );

  try {
    const parsed = new URL(value);
    let mutated = false;

    if (parsed.username) {
      parsed.username = '***';
      mutated = true;
    }
    if (parsed.password) {
      parsed.password = '***';
      mutated = true;
    }

    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEY_PATTERN.test(key)) {
        parsed.searchParams.set(key, '***');
        mutated = true;
      }
    }

    if (mutated) {
      sanitized = parsed.toString();
    }
  } catch {
    return sanitized;
  }

  return sanitized;
}

export function sanitizeForLog(value: unknown, fieldName = ''): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (SENSITIVE_KEY_PATTERN.test(fieldName)) {
    return '***';
  }

  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message)
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForLog(entry, fieldName));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, sanitizeForLog(entry, key)])
    );
  }

  return String(value);
}

export const logger = {
  info(event: string, details?: unknown) {
    console.log(JSON.stringify({ level: 'info', event, details: sanitizeForLog(details), ts: new Date().toISOString() }));
  },
  error(event: string, details?: unknown) {
    console.error(JSON.stringify({ level: 'error', event, details: sanitizeForLog(details), ts: new Date().toISOString() }));
  }
};
