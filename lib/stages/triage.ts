import { getSql, recordRun } from '../db/pg';
import { triage } from '../jev/triage';
import { mapPool } from '../pool';
import { expired, type StageOpts } from './types';

export interface TriageStats {
  kept: number;
  rejected: number;
  errors: number;
  skipped: number;
  tokens: number;
  cost: number;
  roles: Record<string, number>;
  stoppedEarly: boolean;
}

export interface TriageOpts extends StageOpts {
  threshold?: number;
  ats?: string;
}

/**
 * Stage 1. Jev reads title, company and location and decides whether the posting
 * is worth fetching a description for. Tuned for recall: the next stage costs an
 * HTTP request, not a model call, so a false positive is cheap and a false
 * negative is a job you never see.
 */
export async function runTriage(opts: TriageOpts = {}): Promise<TriageStats> {
  const log = opts.log ?? console.log;
  const sql = getSql();
  const limit = opts.limit ?? 200;
  const concurrency = opts.concurrency ?? 8;
  const threshold = opts.threshold ?? 0.35;
  const startedAt = new Date();

  const rows = (opts.ats
    ? await sql`SELECT url, title, company, location, ats FROM jobs
                WHERE stage = 'new' AND ats = ${opts.ats} LIMIT ${limit}`
    : await sql`SELECT url, title, company, location, ats FROM jobs
                WHERE stage = 'new' LIMIT ${limit}`) as {
    url: string;
    title: string;
    company: string;
    location: string | null;
    ats: string | null;
  }[];

  const stats: TriageStats = {
    kept: 0,
    rejected: 0,
    errors: 0,
    skipped: 0,
    tokens: 0,
    cost: 0,
    roles: {},
    stoppedEarly: false,
  };
  if (!rows.length) {
    log('triage: nothing pending');
    return stats;
  }
  log(`triaging ${rows.length} postings at concurrency ${concurrency}, keep threshold ${threshold}`);

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
        const r = await triage(row);
        const keep = r.worthProbability >= threshold;
        stats[keep ? 'kept' : 'rejected']++;
        stats.roles[r.role] = (stats.roles[r.role] ?? 0) + 1;
        stats.tokens += r.inputTokens;
        stats.cost += r.costUsd;
        await sql`
          UPDATE jobs SET stage = ${keep ? 'triaged' : 'triage_reject'}, triage_role = ${r.role},
            triage_role_p = ${r.roleProbability}, triage_seniority = ${r.seniority},
            triage_worth_p = ${r.worthProbability}, triage_confidence = ${r.confidence},
            triaged_at = ${now}, error = NULL
          WHERE url = ${row.url}`;
      } catch (error) {
        stats.errors++;
        await sql`
          UPDATE jobs SET stage = 'error', triaged_at = ${now},
            error = ${(error as Error).message.slice(0, 300)}
          WHERE url = ${row.url}`;
      }
    },
    (done, total) => {
      if (done % 100 === 0 || done === total) log(`  ${done}/${total}`);
    },
  );

  await recordRun('triage', startedAt, stats);
  log(
    `triage: kept ${stats.kept}, rejected ${stats.rejected}, errors ${stats.errors}` +
      (stats.skipped ? `, skipped ${stats.skipped} (out of time)` : '') +
      ` — $${stats.cost.toFixed(4)}`,
  );
  return stats;
}
