import { getSql, recordRun } from '../db/pg';
import { scoreJob } from '../jev/score';
import { mapPool } from '../pool';
import { IGNORED } from '../verdicts';
import { expired, type StageOpts } from './types';

export interface ScoreStats {
  scored: number;
  errors: number;
  skipped: number;
  /** Scored, then auto-ignored because jev's top choice was pre-sales. */
  preSalesIgnored: number;
  tokens: number;
  cost: number;
  stoppedEarly: boolean;
}

/**
 * Stage 3. The real classifier: jev reads the CV, the targets and the full
 * description, answers eleven atomic questions, and lib/jev/score.ts combines them
 * in code into one fit score.
 */
export async function runScore(opts: StageOpts = {}): Promise<ScoreStats> {
  const log = opts.log ?? console.log;
  const sql = getSql();
  const limit = opts.limit ?? 100;
  const concurrency = opts.concurrency ?? 6;
  const startedAt = new Date();

  const rows = (await sql`
    SELECT url, title, company, location, description FROM jobs
    WHERE stage = 'fetched' AND description IS NOT NULL LIMIT ${limit}`) as {
    url: string;
    title: string;
    company: string;
    location: string | null;
    description: string;
  }[];

  const stats: ScoreStats = {
    scored: 0,
    errors: 0,
    skipped: 0,
    preSalesIgnored: 0,
    tokens: 0,
    cost: 0,
    stoppedEarly: false,
  };
  if (!rows.length) {
    log('score: nothing pending');
    return stats;
  }
  log(`scoring ${rows.length} postings at concurrency ${concurrency}`);

  await mapPool(
    rows,
    concurrency,
    async (row) => {
      if (expired(opts.deadline)) {
        stats.skipped++;
        stats.stoppedEarly = true;
        return;
      }
      const now = new Date().toISOString();
      try {
        const r = await scoreJob(row);
        stats.scored++;
        stats.tokens += r.inputTokens;
        stats.cost += r.costUsd;
        await sql`
          UPDATE jobs SET stage = 'scored', fit_score = ${r.fitScore},
            fit_confidence = ${r.confidence}, blocker_p = ${r.blockerProbability},
            score_json = ${JSON.stringify({ answers: r.answers, components: r.components })}::jsonb,
            scored_at = ${now}, error = NULL
          WHERE url = ${row.url}`;
        // The candidate does not want pre-sales. This is a hard filter, not a
        // score penalty, but it uses the dashboard's own Ignore label so a wrong
        // call is one click to undo. DO NOTHING keeps an existing label as is.
        if (r.motion === 'preSales') {
          stats.preSalesIgnored++;
          await sql`
            INSERT INTO labels (url, verdict) VALUES (${row.url}, ${IGNORED})
            ON CONFLICT (url) DO NOTHING`;
        }
      } catch (error) {
        stats.errors++;
        await sql`
          UPDATE jobs SET stage = 'error', scored_at = ${now},
            error = ${(error as Error).message.slice(0, 300)}
          WHERE url = ${row.url}`;
      }
    },
    (done, total) => {
      if (done % 25 === 0 || done === total) log(`  ${done}/${total}`);
    },
  );

  await recordRun('score', startedAt, stats);
  log(
    `score: scored ${stats.scored}, errors ${stats.errors}` +
      (stats.preSalesIgnored ? `, ignored ${stats.preSalesIgnored} as pre-sales` : '') +
      (stats.skipped ? `, skipped ${stats.skipped} (out of time)` : '') +
      ` — $${stats.cost.toFixed(4)}`,
  );
  return stats;
}
