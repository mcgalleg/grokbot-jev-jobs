import { migrate, getSql, recordRun } from '@/lib/db/pg';
import { runIngest } from '@/lib/stages/ingest';
import { runTriage } from '@/lib/stages/triage';
import { runDescribe } from '@/lib/stages/describe';
import { runScore } from '@/lib/stages/score';

export const dynamic = 'force-dynamic';

/**
 * 800s is the generally-available ceiling on Pro. A daily differential is
 * ~1,750 postings to triage and ~190 to describe and score, which measures at
 * roughly five minutes, so this is about 2.5x headroom.
 */
export const maxDuration = 800;

/** Stop starting new work with this much of the budget left, so the run can finish tidily. */
const RESERVE_MS = 45_000;

/**
 * Per-stage share of the remaining budget. Triage is the long pole by volume;
 * describe is the long pole by latency because Workday runs at concurrency 3.
 * These are ceilings, not targets — a stage that finishes early hands the rest on.
 */
const SHARE = { ingest: 0.25, triage: 0.3, describe: 0.25, score: 0.2 } as const;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // Vercel Cron signs requests with CRON_SECRET when it is set. Refuse rather
  // than run unauthenticated: this endpoint spends money.
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorised(req)) {
    return Response.json({ error: 'unauthorised' }, { status: 401 });
  }

  const budgetStart = Date.now();
  const hardDeadline = budgetStart + (maxDuration * 1000 - RESERVE_MS);
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(`[cron] ${line}`);
  };

  const { searchParams } = new URL(req.url);
  const full = searchParams.get('full') === '1';

  const startedAt = new Date();
  try {
    await migrate();

    // Health check: proves the schedule can reach this route past Deployment
    // Protection, and that the database is live, without spending anything.
    if (searchParams.get('probe') === '1') {
      const sql = getSql();
      const counts = (await sql`
        SELECT stage, count(*)::int AS n FROM jobs GROUP BY stage`) as
        { stage: string; n: number }[];
      return Response.json({
        ok: true,
        probe: true,
        region: process.env.VERCEL_REGION ?? 'local',
        stages: Object.fromEntries(counts.map((r) => [r.stage, r.n])),
        lastIngest: await lastIngestCutoff(),
      });
    }

    // Differential window: everything first seen since the last successful
    // ingest, minus an hour of slack for clock skew and feed lag. Falls back to
    // a full scan when there is no previous run, which is what the first cron
    // invocation after deploy needs.
    const since = full ? null : await lastIngestCutoff();
    log(since ? `window: first_seen >= ${since}` : 'window: full scan');

    const budget = (share: number) =>
      Math.min(hardDeadline, Date.now() + (hardDeadline - Date.now()) * share);

    const ingest = await runIngest({ since, deadline: budget(SHARE.ingest), log });
    const triage = await runTriage({
      limit: 5_000,
      concurrency: 8,
      deadline: budget(SHARE.triage),
      log,
    });
    const describe = await runDescribe({
      limit: 1_500,
      concurrency: 6,
      deadline: budget(SHARE.describe),
      log,
    });
    const score = await runScore({
      limit: 1_500,
      concurrency: 6,
      deadline: hardDeadline,
      log,
    });

    const summary = {
      ok: true,
      elapsedMs: Date.now() - budgetStart,
      costUsd: Number((triage.cost + score.cost).toFixed(4)),
      window: since ?? 'full',
      ingest: { seen: ingest.seen, kept: ingest.kept, skippedOld: ingest.skippedOld },
      triage: { kept: triage.kept, rejected: triage.rejected, errors: triage.errors },
      describe: {
        fetched: describe.fetched,
        expired: describe.expiredPostings,
        errors: describe.errors,
      },
      score: { scored: score.scored, errors: score.errors },
      stoppedEarly:
        ingest.stoppedEarly || triage.stoppedEarly || describe.stoppedEarly || score.stoppedEarly,
    };
    await recordRun('cron', startedAt, summary);
    log(`done in ${(summary.elapsedMs / 1000).toFixed(1)}s for $${summary.costUsd}`);
    return Response.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[cron] failed', error);
    await recordRun('cron', startedAt, { ok: false, error: message, lines }).catch(() => {});
    return Response.json({ ok: false, error: message, lines }, { status: 500 });
  }
}

/**
 * When the last ingest finished, less an hour.
 *
 * The slack matters: the feed's `first_seen` is stamped by the upstream scraper,
 * not by us, so a posting can appear with a timestamp slightly before our last
 * run. An hour of overlap costs a few redundant upserts and avoids silently
 * dropping postings.
 */
async function lastIngestCutoff(): Promise<string | null> {
  const sql = getSql();
  const rows = (await sql`
    SELECT (finished_at - interval '1 hour') AS cutoff
    FROM runs WHERE kind = 'ingest' AND finished_at IS NOT NULL
    ORDER BY finished_at DESC LIMIT 1`) as { cutoff: Date | string | null }[];
  const cutoff = rows[0]?.cutoff;
  if (!cutoff) return null;
  return cutoff instanceof Date ? cutoff.toISOString() : new Date(cutoff).toISOString();
}
