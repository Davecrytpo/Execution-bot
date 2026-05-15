type FetchJsonOptions = RequestInit & {
  timeoutMs?: number;
};

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, ...requestInit } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`timeout:${url}`)), timeoutMs);

  try {
    const response = await fetch(url, {
      ...requestInit,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }

    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}
