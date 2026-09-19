import { getSql, recordRun } from '../db/pg';
import { fetchManifest, feedAgeHours, streamChunks, type FeedJob } from '../feed';
import { DEFAULT_SCREEN, screen, type ScreenConfig } from '../screen';
import { expired, type StageOpts } from './types';

export interface IngestStats {
  seen: number;
  kept: number;
  screened: number;
  skippedOld: number;
  inserted: number;
  reasons: Record<string, number>;
  chunks: number;
  stoppedEarly: boolean;
  feedAgeHours: number;
}

/** `limit` is meaningless here — the feed is bounded by chunks, not rows. */
export interface IngestOpts extends Omit<StageOpts, 'limit'> {
  maxChunks?: number;
  screenConfig?: ScreenConfig;
  /**
   * Only consider postings first seen at or after this ISO timestamp.
   *
   * This is what makes a daily run cheap: the feed republishes all ~1.4M
   * postings every day, but only ~31,000 are new. Omit for a full scan.
   */
  since?: string | null;
}

/** Rows per INSERT. Neon's HTTP driver is one request per statement, so batch. */
const INSERT_CHUNK = 500;

/**
 * Stage 0. Pull the published feed, apply the deterministic screen, store rows.
 *
 * Screened-out postings are never written; they are 94% of the feed and storing
 * them would mean 1.4M writes a day to learn nothing.
 */
export async function runIngest(opts: IngestOpts = {}): Promise<IngestStats> {
  const log = opts.log ?? console.log;
  const sql = getSql();
  const startedAt = new Date();
  const screenConfig = opts.screenConfig ?? DEFAULT_SCREEN;

  const manifest = await fetchManifest();
  const ageHours = feedAgeHours(manifest);
  log(
    `feed: ${manifest.chunks.length} chunks, last updated ${manifest.last_updated} (${ageHours.toFixed(1)}h ago)`,
  );
  if (ageHours > 72) {
    log('WARNING: feed is more than 3 days stale. The upstream cron may have stopped.');
  }

  const sinceMs = opts.since ? Date.parse(opts.since) : Number.NaN;
  const differential = !Number.isNaN(sinceMs);
  log(
    differential
      ? `differential: only postings first seen since ${opts.since}`
      : 'full scan: every posting in the feed',
  );

  const maxChunks = opts.maxChunks ?? manifest.chunks.length;
  const stats: IngestStats = {
    seen: 0,
    kept: 0,
    screened: 0,
    skippedOld: 0,
    inserted: 0,
    reasons: {},
    chunks: 0,
    stoppedEarly: false,
    feedAgeHours: ageHours,
  };

  let batch: FeedJob[] = [];
  const flush = async () => {
    if (!batch.length) return;
    stats.inserted += await insertJobs(sql, batch);
    batch = [];
  };

  for await (const { name, index, jobs } of streamChunks(manifest, { maxChunks })) {
    for (const job of jobs) {
      stats.seen++;

      // Cheapest test first: a posting we have already seen needs no screening.
      if (differential) {
        const t = Date.parse(job.first_seen ?? '');
        if (Number.isNaN(t) || t < sinceMs) {
          stats.skippedOld++;
          continue;
        }
      }

      const verdict = screen(job, screenConfig);
      if (!verdict.keep) {
        stats.screened++;
        stats.reasons[verdict.reason] = (stats.reasons[verdict.reason] ?? 0) + 1;
        continue;
      }
      stats.kept++;
      batch.push(job);
      if (batch.length >= INSERT_CHUNK) await flush();
    }
    stats.chunks = index + 1;
    log(`  chunk ${index + 1}/${maxChunks} ${name}: ${jobs.length} rows, kept ${stats.kept} so far`);

    // Checked between chunks: a partial chunk is fine because inserts are
    // idempotent, but finishing the one in hand keeps the log honest.
    if (expired(opts.deadline)) {
      stats.stoppedEarly = true;
      log(`  stopping early at chunk ${index + 1}: out of time budget`);
      break;
    }
  }
  await flush();

  await recordRun('ingest', startedAt, stats);
  log(
    `ingest: scanned ${stats.seen.toLocaleString()}, skipped ${stats.skippedOld.toLocaleString()} already-seen, ` +
      `kept ${stats.kept.toLocaleString()}, inserted/updated ${stats.inserted.toLocaleString()}`,
  );
  if (stats.screened) log(`  screened out ${stats.screened.toLocaleString()}: ${JSON.stringify(stats.reasons)}`);
  return stats;
}

/**
 * Multi-row upsert.
 *
 * ON CONFLICT refreshes the feed-derived columns but deliberately leaves `stage`
 * alone: a posting we have already triaged or scored must not be dragged back to
 * 'new' because the feed restated its title.
 *
 * The feed can list the same URL twice, and Postgres refuses an upsert that
 * touches one row twice in a single statement, so dedupe first (last wins).
 */
async function insertJobs(
  sql: ReturnType<typeof getSql>,
  batch: readonly FeedJob[],
): Promise<number> {
  const unique = [...new Map(batch.map((j) => [j.url!, j])).values()];
  const rows = unique.map((j) => [
    j.url!,
    j.title!,
    j.company!,
    j.location ?? null,
    j.ats ?? null,
    j.skill_level ?? null,
    j.remote ?? null,
    j.is_recruiter ?? null,
    j.salary ? JSON.stringify(j.salary) : null,
    j.updated_at ?? null,
    j.first_seen ?? null,
  ]);

  const values = rows
    .map((_, i) => {
      const b = i * 11;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}::jsonb,$${b + 10},$${b + 11})`;
    })
    .join(',');

  await sql.query(
    `INSERT INTO jobs (url, title, company, location, ats, skill_level, remote,
                       is_recruiter, salary, updated_at, first_seen)
     VALUES ${values}
     ON CONFLICT (url) DO UPDATE SET
       title = excluded.title,
       location = excluded.location,
       salary = excluded.salary,
       updated_at = excluded.updated_at`,
    rows.flat(),
  );
  return rows.length;
}
