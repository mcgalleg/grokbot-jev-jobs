/** Print the current funnel and the top matches. Usage: pnpm report [--top N] */
import '../lib/env.ts';
import { getSql, migrate } from '../lib/db/pg.ts';

const args = process.argv.slice(2);
const i = args.indexOf('--top');
const TOP = i >= 0 && args[i + 1] ? Number(args[i + 1]) : 15;

await migrate();
const sql = getSql();

const stages = (await sql`
  SELECT stage, COUNT(*)::int n FROM jobs GROUP BY stage ORDER BY n DESC`) as
  { stage: string; n: number }[];
console.log('funnel:', JSON.stringify(Object.fromEntries(stages.map((s) => [s.stage, s.n]))));

const spend = (await sql`
  SELECT coalesce(sum((stats->>'cost')::float8), 0) total FROM runs`) as { total: number }[];
console.log(`jev spend to date: $${Number(spend[0]?.total ?? 0).toFixed(4)}`);

const top = (await sql`
  SELECT title, company, location, fit_score, fit_confidence, blocker_p, url, score_json
  FROM jobs WHERE stage = 'scored' ORDER BY fit_score DESC LIMIT ${TOP}`) as {
  title: string;
  company: string;
  location: string | null;
  fit_score: number;
  fit_confidence: number;
  blocker_p: number;
  url: string;
  score_json: { answers?: Record<string, { choice?: string }> } | null;
}[];

console.log(`\n--- top ${top.length} by fit score ---`);
for (const [n, j] of top.entries()) {
  const role = j.score_json?.answers?.role?.choice ?? '?';
  console.log(
    `${String(n + 1).padStart(2)}. ${j.fit_score.toFixed(2).padStart(5)}  conf ${Number(j.fit_confidence).toFixed(2)}  ` +
      `${j.company.slice(0, 18).padEnd(18)} ${j.title.trim().slice(0, 52).padEnd(52)} ` +
      `[${role}] ${(j.location ?? '').slice(0, 24)}`,
  );
}
