import 'server-only';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, hasDatabase } from './db/pg';
import { formatPosted, type SalaryEstimate } from './format';
import { jobs, labels, runs } from './db/pg-schema';

export interface ScoredJob {
  url: string;
  title: string;
  company: string;
  location: string | null;
  ats: string | null;
  fitScore: number;
  fitConfidence: number;
  blockerP: number;
  compBelowFloorP: number;
  role: string;
  components: Record<string, number>;
  answers: Record<string, { type: string; choice?: string; score?: number; probability?: number }>;
  salary: SalaryEstimate | null;
  /** Pre-rendered so the client never recomputes a relative date. See lib/format.ts. */
  posted: { label: string; title: string } | null;
  descriptionChars: number | null;
  verdict: string | null;
}

export interface Funnel {
  stages: Record<string, number>;
  scored: number;
  strong: number;
  /** Rows you marked Applied. */
  applied: number;
  /** Rows you marked either way, so they have left the open list. */
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
  answers?: ScoredJob['answers'];
  components?: Record<string, number>;
}

/**
 * Counters for the stat tiles. All live — the pipeline and the dashboard share
 * one database, so there is nothing to snapshot.
 */
export async function getFunnel(): Promise<Funnel> {
  if (!hasDatabase()) return EMPTY_FUNNEL;
  const db = getDb();

  const [stageRows, counts, spend, lastIngest] = await Promise.all([
    db.select({ stage: jobs.stage, n: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.stage),
    db
      .select({
        scored: sql<number>`count(*) filter (where ${jobs.stage} = 'scored')::int`,
        strong: sql<number>`count(*) filter (where ${jobs.fitScore} >= ${STRONG_THRESHOLD})::int`,
        applied: sql<number>`count(*) filter (where ${jobs.stage} = 'scored' and ${labels.verdict} = 'applied')::int`,
        handled: sql<number>`count(*) filter (where ${jobs.stage} = 'scored' and ${labels.url} is not null)::int`,
      })
      .from(jobs)
      .leftJoin(labels, eq(labels.url, jobs.url)),
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
}

export type JobFilter = 'open' | 'applied' | 'all';

export async function getJobs(filter: JobFilter = 'open', limit = LIST_LIMIT): Promise<ScoredJob[]> {
  if (!hasDatabase()) return [];
  const db = getDb();

  // The table now holds every stage, so scored-only is part of each filter.
  const scored = eq(jobs.stage, 'scored');
  const where = {
    // Applied and Ignored both leave the open list; only Applied has its own tab,
    // because an ignored posting is one you never want to see again.
    open: and(scored, isNull(labels.url)),
    applied: and(scored, eq(labels.verdict, 'applied')),
    all: scored,
  }[filter];

  const rows = await db
    .select({
      url: jobs.url,
      title: jobs.title,
      company: jobs.company,
      location: jobs.location,
      ats: jobs.ats,
      fitScore: jobs.fitScore,
      fitConfidence: jobs.fitConfidence,
      blockerP: jobs.blockerP,
      scoreJson: jobs.scoreJson,
      salary: jobs.salary,
      postedAt: jobs.postedAt,
      firstSeen: jobs.firstSeen,
      descriptionChars: jobs.descriptionChars,
      verdict: labels.verdict,
    })
    .from(jobs)
    .leftJoin(labels, eq(labels.url, jobs.url))
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
      ats: r.ats,
      fitScore: Number(r.fitScore ?? 0),
      fitConfidence: Number(r.fitConfidence ?? 0),
      blockerP: Number(r.blockerP ?? 0),
      compBelowFloorP: Number(answers.compBelowFloor?.probability ?? 0),
      role: answers.role?.choice ?? 'unknown',
      components: score.components ?? {},
      answers,
      salary: (r.salary ?? null) as SalaryEstimate | null,
      posted: formatPosted(r.postedAt, r.firstSeen, now),
      descriptionChars: r.descriptionChars,
      verdict: r.verdict,
    };
  });
}
