/** Run tasks with bounded concurrency, preserving input order in the results. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      onProgress?.(++done, items.length);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Whether a failed call is worth repeating. Rate limits, 5xx, timeouts and
 * network drops are; a 4xx or a validation error will fail the same way again.
 * Unknown errors are not retried, so a bug surfaces on the first attempt rather
 * than after a minute of backoff.
 */
export function isTransient(error: unknown): boolean {
  const e = error as { statusCode?: number; isRetryable?: boolean; name?: string } | null;
  if (typeof e?.statusCode === 'number') return e.statusCode === 429 || e.statusCode >= 500;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return true;
  if (typeof e?.isRetryable === 'boolean') return e.isRetryable;
  // fetch() reports a dropped connection as a bare TypeError.
  return error instanceof TypeError;
}

/**
 * Retry transient failures with backoff and jitter. This is the only retry
 * layer for Jev calls: `askJev` passes `maxRetries: 0` to the AI SDK, which
 * otherwise retries twice underneath and multiplies the attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 4, baseMs = 500 }: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts - 1) throw error;
      const delay = baseMs * 2 ** attempt * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
