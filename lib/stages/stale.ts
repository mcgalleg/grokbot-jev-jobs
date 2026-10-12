import { getSql, recordRun } from '../db/pg';
import { IGNORED } from '../verdicts';
import type { StageOpts } from './types';

/** Open postings older than this are ignored. */
export const STALE_DAYS = 45;

export interface StaleStats {
  days: number;
  ignored: number;
}

/**
 * Open postings past the cutoff. $1 is the cutoff in days.
 *
 * Age is the ATS's `updated_at`, else the aggregator's `first_seen` — the same
 * fallback the posted column uses (formatPosted in lib/format.ts). `l.url IS
 * NULL` means no label of any kind: not ignored, and not restored either, so a
 * posting the user brought back stays back.
 */
export const STALE_FROM = `
  FROM jobs j
  LEFT JOIN labels l ON l.url = j.url
  LEFT JOIN applies a ON a.url = j.url
  WHERE j.stage = 'scored'
    AND l.url IS NULL
    AND (a.url IS NULL OR a.status <> 'applied')
    AND COALESCE(j.updated_at, j.first_seen)::timestamptz < now() - make_interval(days => $1)`;

/**
 * Sweep, not a stage: no model calls, one statement. Postings age into the
 * cutoff while sitting in the table, so this looks at every open row rather than
 * only the ones scored this run. Uses the dashboard's own Ignore label, so a
 * wrong call is one click to undo.
 */
export async function runIgnoreStale(
  opts: Pick<StageOpts, 'log'> & { days?: number } = {},
): Promise<StaleStats> {
  const log = opts.log ?? console.log;
  const days = opts.days ?? STALE_DAYS;
  const startedAt = new Date();

  const rows = await getSql().query(
    `INSERT INTO labels (url, verdict)
     SELECT j.url, '${IGNORED}' ${STALE_FROM}
     ON CONFLICT (url) DO NOTHING
     RETURNING url`,
    [days],
  );
  const stats: StaleStats = { days, ignored: rows.length };
  await recordRun('stale', startedAt, stats);
  log(`stale: ignored ${stats.ignored} postings older than ${days} days`);
  return stats;
}
