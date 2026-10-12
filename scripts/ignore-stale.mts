/**
 * Preview, or run by hand, the stale-posting sweep that the cron pipeline runs
 * daily (lib/stages/stale.ts). Ignore is the dashboard's own "not interested"
 * label, so any row this removes can be restored from the UI.
 *
 * Usage:
 *   pnpm ignore:stale               count and sample, change nothing
 *   pnpm ignore:stale --apply       ignore them (same as `pnpm stale`)
 *   pnpm ignore:stale --days 60     use a different cutoff
 */
import '../lib/env.ts';
import { getSql } from '../lib/db/pg.ts';
import { STALE_DAYS, STALE_FROM, runIgnoreStale } from '../lib/stages/stale.ts';

const args = process.argv.slice(2);
const di = args.indexOf('--days');
const days = di >= 0 ? Number(args[di + 1]) : STALE_DAYS;
if (!Number.isFinite(days) || days <= 0) throw new Error('--days needs a positive number');

if (args.includes('--apply')) {
  await runIgnoreStale({ days });
} else {
  const sql = getSql();
  const [{ n }] = await sql.query(`SELECT count(*)::int AS n ${STALE_FROM}`, [days]);
  const newest = await sql.query(
    `SELECT j.title, j.company, COALESCE(j.updated_at, j.first_seen) AS posted ${STALE_FROM}
     ORDER BY COALESCE(j.updated_at, j.first_seen)::timestamptz DESC LIMIT 10`,
    [days],
  );
  console.log(`would ignore ${n} open postings older than ${days} days. Newest of them:`);
  for (const r of newest) console.log(`  ${String(r.posted).slice(0, 10)}  ${String(r.title).trim()} — ${r.company}`);
  console.log('\ndry run: nothing changed. Re-run with --apply to ignore these.');
}
