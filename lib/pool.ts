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

/** Retry on transient gateway failures (429 and 5xx), with backoff and jitter. */
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
      const status = (error as { statusCode?: number })?.statusCode;
      const retryable = status === 429 || status === undefined || (status >= 500 && status < 600);
      if (!retryable || attempt === attempts - 1) throw error;
      const delay = baseMs * 2 ** attempt * (0.5 + Math.random());
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
