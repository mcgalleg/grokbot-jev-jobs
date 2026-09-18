import { getSql, recordRun } from '../db/pg';
import {
  fetchDescription,
  JobExpiredError,
  platformOf,
  PLATFORM_CONCURRENCY,
  type Platform,
} from '../ats';
import { mapPool } from '../pool';
import { expired, type StageOpts } from './types';

export interface DescribeStats {
  fetched: number;
  expiredPostings: number;
  errors: number;
  reused: number;
  parked: number;
  skipped: number;
  chars: number;
  byPlatform: Record<string, { ok: number; expired: number; error: number }>;
  stoppedEarly: boolean;
}

interface Row {
  url: string;
  title: string;
  company: string;
  ats: string | null;
  platform: Platform;
}

/**
 * Stage 2. Pull the full description for postings that survived triage.
 *
 * Verified to work from a Vercel datacenter IP (iad1) on all four platforms,
 * Workday included, at the same byte counts as a residential connection.
 */
export async function runDescribe(opts: StageOpts = {}): Promise<DescribeStats> {
  const log = opts.log ?? console.log;
  const sql = getSql();
  const limit = opts.limit ?? 200;
  const concurrency = opts.concurrency ?? 6;
  const startedAt = new Date();

  const stats: DescribeStats = {
    fetched: 0,
    expiredPostings: 0,
    errors: 0,
    reused: 0,
    parked: 0,
    skipped: 0,
    chars: 0,
    byPlatform: {},
    stoppedEarly: false,
  };

  // Text we already hold skips straight to scoring. Descriptions do not depend
  // on the profile, so re-running triage after editing targets.md must never
  // re-hit an ATS for text already stored.
  const reused = await sql`
    UPDATE jobs SET stage = 'fetched'
    WHERE stage = 'triaged' AND description IS NOT NULL AND description_chars > 0
    RETURNING url`;
  stats.reused = reused.length;
  if (stats.reused) log(`reusing ${stats.reused} descriptions already stored`);

  const pending = (await sql`
    SELECT url, title, company, ats FROM jobs
    WHERE stage = 'triaged' AND description IS NULL
    ORDER BY company LIMIT ${limit}`) as Omit<Row, 'platform'>[];

  const doable: Row[] = [];
  const parked: string[] = [];
  const parkedBy: Record<string, number> = {};
  for (const row of pending) {
    const platform = platformOf(row.ats, row.url);
    if (platform) doable.push({ ...row, platform });
    else {
      stats.parked++;
      parked.push(row.url);
      parkedBy[row.ats ?? 'unknown'] = (parkedBy[row.ats ?? 'unknown'] ?? 0) + 1;
    }
  }

  // Move them out of 'triaged' rather than re-reading them every night. There is
  // no fetcher for these platforms, so they are terminal until one is written —
  // and left in place they would silently eat the row limit forever.
  if (parked.length) {
    await sql.query(
      `UPDATE jobs SET stage = 'unsupported', error = 'no fetcher for this ATS'
       WHERE url = ANY($1::text[])`,
      [parked],
    );
    log(`parked ${parked.length} on unsupported platforms: ${JSON.stringify(parkedBy)}`);
  }

  if (!doable.length) {
    log('describe: nothing fetchable pending');
    await recordRun('describe', startedAt, stats);
    return stats;
  }

  const byPlatform = new Map<Platform, Row[]>();
  for (const row of doable) {
    const list = byPlatform.get(row.platform) ?? [];
    list.push(row);
    byPlatform.set(row.platform, list);
  }

  const plan = [...byPlatform]
    .map(([p, list]) => `${p} ${list.length}@${Math.min(concurrency, PLATFORM_CONCURRENCY[p])}`)
    .join(', ');
  log(`fetching ${doable.length} descriptions: ${plan}`);


  let done = 0;
  // Each platform runs at its own ceiling, in parallel with the others; rows are
  // ordered by company so the board-style platforms hit their cache.
  await Promise.all(
    [...byPlatform].map(([platform, list]) =>
      mapPool(list, Math.min(concurrency, PLATFORM_CONCURRENCY[platform]), async (row) => {
        if (expired(opts.deadline)) {
          stats.skipped++;
          stats.stoppedEarly = true;
          return;
        }
        const now = new Date().toISOString();
        const tally = (stats.byPlatform[platform] ??= { ok: 0, expired: 0, error: 0 });
        try {
          const d = await fetchDescription(row.url, row.ats, row.company);
          stats.fetched++;
          stats.chars += d.text.length;
          tally.ok++;
          await sql`
            UPDATE jobs SET stage = 'fetched', description = ${d.text},
              description_chars = ${d.text.length}, fetched_at = ${now}, error = NULL
            WHERE url = ${row.url}`;
        } catch (error) {
          const gone = error instanceof JobExpiredError;
          if (gone) {
            stats.expiredPostings++;
            tally.expired++;
          } else {
            stats.errors++;
            tally.error++;
          }
          await sql`
            UPDATE jobs SET stage = ${gone ? 'expired' : 'error'},
              error = ${gone ? 'posting expired' : (error as Error).message.slice(0, 300)},
              fetched_at = ${now}
            WHERE url = ${row.url}`;
        }
        done++;
        if (done % 50 === 0 || done === doable.length) log(`  ${done}/${doable.length}`);
      }),
    ),
  );

  await recordRun('describe', startedAt, stats);
  log(
    `describe: fetched ${stats.fetched}, expired ${stats.expiredPostings}, errors ${stats.errors}` +
      (stats.skipped ? `, skipped ${stats.skipped} (out of time)` : ''),
  );
  return stats;
}
