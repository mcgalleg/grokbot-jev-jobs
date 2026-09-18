/**
 * Health check for the schedule itself.
 *
 * Deployment Protection returns a 302 to external callers, and Vercel Cron
 * treats a 3xx as a completed invocation — so a protected cron path fails
 * silently, every night, with a green tick. This route exists so that failure
 * mode is observable: it records every invocation, spends nothing, and touches
 * no pipeline state.
 */
import { getSql, migrate, recordRun } from '@/lib/db/pg';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const authorised = Boolean(secret) && req.headers.get('authorization') === `Bearer ${secret}`;

  await migrate();
  const sql = getSql();
  const counts = (await sql`SELECT stage, count(*)::int AS n FROM jobs GROUP BY stage`) as
    { stage: string; n: number }[];

  const result = {
    ok: true,
    authorised,
    viaCron: req.headers.has('x-vercel-cron-schedule'),
    schedule: req.headers.get('x-vercel-cron-schedule'),
    region: process.env.VERCEL_REGION ?? 'local',
    stages: Object.fromEntries(counts.map((r) => [r.stage, r.n])),
    at: new Date().toISOString(),
  };
  await recordRun('probe', new Date(), result);
  return Response.json(result);
}
