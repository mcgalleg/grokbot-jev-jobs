/**
 * The upstream job feed.
 *
 * Feashliaa/job-board-aggregator publishes ~1M postings daily as gzipped chunks
 * on GitHub Pages. We read it; we never run their scraper. The data repo is
 * force-pushed each run, so our own database is the only durable record.
 *
 * Records carry title/company/location/url but NOT descriptions. Those come
 * from the ATS later, in lib/ats.
 */

export const FEED_BASE =
  process.env.FEED_BASE ?? 'https://feashliaa.github.io/job-board-data/data/chunks';

export interface FeedManifest {
  chunks: string[];
  last_updated: string;
  total_jobs?: number;
}

export interface FeedJob {
  title?: string;
  company?: string;
  location?: string;
  url?: string;
  ats?: string;
  skill_level?: string;
  is_recruiter?: boolean;
  remote?: boolean;
  /** Market estimate from the aggregator's lookup table, not the posting's stated pay. */
  salary?: { p25?: number; median?: number; p75?: number; n?: number } | null;
  updated_at?: string;
  first_seen?: string;
}

export async function fetchManifest(): Promise<FeedManifest> {
  const res = await fetch(`${FEED_BASE}/jobs_manifest.json?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as FeedManifest;
}

/** How stale is the feed? The author's cron can stop without warning. */
export function feedAgeHours(manifest: FeedManifest): number {
  const t = Date.parse(manifest.last_updated);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : (Date.now() - t) / 3_600_000;
}

async function fetchChunk(name: string, version: string): Promise<FeedJob[]> {
  const res = await fetch(`${FEED_BASE}/${name}?v=${encodeURIComponent(version)}`);
  if (!res.ok) throw new Error(`Chunk ${name} failed: ${res.status}`);
  if (!res.body) throw new Error(`Chunk ${name} returned no body`);
  const text = await new Response(
    res.body.pipeThrough(new DecompressionStream('gzip')),
  ).text();
  return JSON.parse(text) as FeedJob[];
}

/** Yield chunks one at a time so a full pull never holds 1M records in memory. */
export async function* streamChunks(
  manifest: FeedManifest,
  opts: { maxChunks?: number } = {},
): AsyncGenerator<{ name: string; index: number; jobs: FeedJob[] }> {
  const names = manifest.chunks.slice(0, opts.maxChunks ?? manifest.chunks.length);
  for (const [index, name] of names.entries()) {
    yield { name, index, jobs: await fetchChunk(name, manifest.last_updated) };
  }
}
