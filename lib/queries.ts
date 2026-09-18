import 'server-only';
import { cache } from 'react';
import { and, desc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { isApplyStatus } from './apply';
import { IGNORED } from './verdicts';
import { ensureApplySchema, getDb, hasDatabase, isUndefinedTable } from './db/pg';
import { formatPosted, type SalaryEstimate } from './format';
import { applies, jobs, labels, runs } from './db/pg-schema';
import type { JobBreakdown, JobListItem } from './job-view';

export type { JobAnswer, JobBreakdown, JobListItem } from './job-view';

export interface Funnel {
  stages: Record<string, number>;
  scored: number;
  strong: number;
  /** Rows Rudy reported as applied. */
  applied: number;
  /** Ignored, or applied — they have left the open list. */
  handled: number;
  /** Rows the pipeline still owes work on. Zero in the healthy case. */
  pending: number;
  spendUsd: number;
  lastIngest: string | null;
}

/** Fit score at or above this reads as a real candidate match. */
export const STRONG_THRESHOLD = 6;

/**
 * Stages the nightly cron still has work to do on. Everything else is terminal:
 * scored, triage_reject, expired, unsupported and error are all final answers.
 */
const PENDING_STAGES = ['new', 'triaged', 'fetched'] as const;

/**
 * How many rows the list renders.
 *
 * It is a page-weight cap, not a quality bar — the list is ordered by score, so
 * it cuts from the bottom. It has to stay comfortably above the strong count or
 * the "Strong (6+)" tile promises rows the list will not show: at 150 the cut
 * landed at 6.02 and ten strong matches were unreachable.
 */
export const LIST_LIMIT = 400;

const EMPTY_FUNNEL: Funnel = {
  stages: {},
  scored: 0,
  strong: 0,
  applied: 0,
  handled: 0,
  pending: 0,
  spendUsd: 0,
  lastIngest: null,
};

interface ScoreJson {
  answers?: JobBreakdown['answers'];
  components?: Record<string, number>;
}

async function withApplySchema<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isUndefinedTable(error)) throw error;
    await ensureApplySchema();
    return run();
  }
}

/**
 * Counters for the stat tiles. All live — the pipeline and the dashboard share
 * one database, so there is nothing to snapshot.
 */
export const getFunnel = cache(async function getFunnel(): Promise<Funnel> {
  if (!hasDatabase()) return EMPTY_FUNNEL;
  return withApplySchema(async () => {
  const db = getDb();

  const [stageRows, counts, spend, lastIngest] = await Promise.all([
    db.select({ stage: jobs.stage, n: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.stage),
    db
      .select({
        scored: sql<number>`count(*) filter (where ${jobs.stage} = 'scored')::int`,
        strong: sql<number>`count(*) filter (where ${jobs.fitScore} >= ${STRONG_THRESHOLD})::int`,
        applied: sql<number>`count(*) filter (where ${jobs.stage} = 'scored' and ${applies.status} = 'applied')::int`,
        handled: sql<number>`count(*) filter (where ${jobs.stage} = 'scored' and (${labels.verdict} = ${IGNORED} or ${applies.status} = 'applied'))::int`,
      })
      .from(jobs)
      .leftJoin(labels, eq(labels.url, jobs.url))
      .leftJoin(applies, eq(applies.url, jobs.url)),
    db.select({ total: sql<number>`coalesce(sum((${runs.stats}->>'cost')::float8), 0)` }).from(runs),
    db
      .select({ at: sql<string | null>`max(${runs.finishedAt})::text` })
      .from(runs)
      .where(eq(runs.kind, 'ingest')),
  ]);

  const row = counts[0] ?? { scored: 0, strong: 0, applied: 0, handled: 0 };
  const stages = Object.fromEntries(stageRows.map((r) => [r.stage, r.n]));
  // Every stage that is not terminal: the pipeline owes these rows more work.
  const pending = PENDING_STAGES.reduce((n, stage) => n + (stages[stage] ?? 0), 0);

  return {
    stages,
    scored: row.scored,
    strong: row.strong,
    applied: row.applied,
    handled: row.handled,
    pending,
    spendUsd: Number(spend[0]?.total ?? 0),
    lastIngest: lastIngest[0]?.at ?? null,
  };
  });
});

export type JobFilter = 'open' | 'applied' | 'all';

export const getJobs = cache(async function getJobs(
  filter: JobFilter = 'open',
  limit = LIST_LIMIT,
): Promise<JobListItem[]> {
  if (!hasDatabase()) return [];
  return withApplySchema(async () => {
    const db = getDb();

    // The table now holds every stage, so scored-only is part of each filter.
    const scored = eq(jobs.stage, 'scored');
    const notIgnored = or(isNull(labels.url), ne(labels.verdict, IGNORED));
    const notApplied = or(isNull(applies.url), ne(applies.status, 'applied'));
    const where = {
      // Ignore and a successful Rudy write-back leave Open. Applying / failed /
      // blocked / skipped stay here so a retry is one click.
      open: and(scored, notIgnored, notApplied),
      applied: and(scored, eq(applies.status, 'applied')),
      all: scored,
    }[filter];

    const rows = await db
      .select({
        url: jobs.url,
        title: jobs.title,
        company: jobs.company,
        location: jobs.location,
        fitScore: jobs.fitScore,
        fitConfidence: jobs.fitConfidence,
        blockerP: jobs.blockerP,
        scoreJson: jobs.scoreJson,
        salary: jobs.salary,
        postedAt: jobs.postedAt,
        firstSeen: jobs.firstSeen,
        verdict: labels.verdict,
        applyStatus: applies.status,
        applyDetail: applies.detail,
      })
      .from(jobs)
      .leftJoin(labels, eq(labels.url, jobs.url))
      .leftJoin(applies, eq(applies.url, jobs.url))
      .where(where)
      .orderBy(desc(jobs.fitScore))
      .limit(limit);

    // One clock reading for the whole page, so two rows a millisecond apart
    // can never land on different sides of a day boundary.
    const now = Date.now();

    return rows.map((r) => {
      const score = (r.scoreJson ?? {}) as ScoreJson;
      const answers = score.answers ?? {};
      return {
        url: r.url,
        title: r.title.trim(),
        company: r.company,
        location: r.location,
        fitScore: Number(r.fitScore ?? 0),
        fitConfidence: Number(r.fitConfidence ?? 0),
        blockerP: Number(r.blockerP ?? 0),
        compBelowFloorP: Number(answers.compBelowFloor?.probability ?? 0),
        role: answers.role?.choice ?? 'unknown',
        salary: (r.salary ?? null) as SalaryEstimate | null,
        posted: formatPosted(r.postedAt, r.firstSeen, now),
        ignored: r.verdict === IGNORED,
        applyStatus: r.applyStatus && isApplyStatus(r.applyStatus) ? r.applyStatus : null,
        applyDetail: r.applyDetail,
      };
    });
  });
});

export async function getJobBreakdown(jobUrl: string): Promise<JobBreakdown | null> {
  if (!jobUrl || !hasDatabase()) return null;
  const db = getDb();
  const [row] = await db
    .select({ scoreJson: jobs.scoreJson })
    .from(jobs)
    .where(eq(jobs.url, jobUrl))
    .limit(1);
  if (!row) return null;
  const score = (row.scoreJson ?? {}) as ScoreJson;
  return {
    components: score.components ?? {},
    answers: score.answers ?? {},
  };
}
