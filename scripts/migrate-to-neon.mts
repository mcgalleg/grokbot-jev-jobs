/**
 * One-time move of the local SQLite working set into Neon.
 *
 * The pipeline now runs on Vercel against Postgres, but the ~81k rows on disk
 * represent real money already spent with jev — re-triaging them would cost
 * roughly $4 to learn what we already know. This lifts them across so the first
 * cron run starts from the current state rather than from nothing.
 *
 * Idempotent: every write is an upsert keyed on url, so a partial run can simply
 * be re-run.
 *
 * Usage: pnpm migrate:neon [--batch N] [--dry-run]
 */
import '../lib/env.ts';
import { sqlite } from '../lib/db/index.ts';
import { getSql, migrate } from '../lib/db/pg.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const num = (n: string, d: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};

const BATCH = num('batch', 200);
const DRY = flag('dry-run');

/** Descriptions are ~8KB each, so cap payload as well as row count. */
const MAX_BATCH_BYTES = 4_000_000;

/** The old schema overloaded 'screened_out' for postings that left the board. */
const STAGE_MAP: Record<string, string> = { screened_out: 'expired' };

interface Row {
  url: string;
  title: string;
  company: string;
  location: string | null;
  ats: string | null;
  skill_level: string | null;
  remote: number | null;
  is_recruiter: number | null;
  salary: string | null;
  updated_at: string | null;
  first_seen: string | null;
  stage: string;
  error: string | null;
  triage_role: string | null;
  triage_role_p: number | null;
  triage_seniority: number | null;
  triage_worth_p: number | null;
  triage_confidence: number | null;
  triaged_at: string | null;
  description: string | null;
  description_chars: number | null;
  fetched_at: string | null;
  fit_score: number | null;
  fit_confidence: number | null;
  blocker_p: number | null;
  score_json: string | null;
  scored_at: string | null;
}

const COLUMNS = [
  'url', 'title', 'company', 'location', 'ats', 'skill_level', 'remote', 'is_recruiter',
  'salary', 'updated_at', 'first_seen', 'stage', 'error', 'triage_role', 'triage_role_p',
  'triage_seniority', 'triage_worth_p', 'triage_confidence', 'triaged_at', 'description',
  'description_chars', 'fetched_at', 'fit_score', 'fit_confidence', 'blocker_p',
  'score_json', 'scored_at',
] as const;

/** Columns refreshed on conflict — everything except the primary key. */
const UPDATES = COLUMNS.filter((c) => c !== 'url')
  .map((c) => `${c} = excluded.${c}`)
  .join(', ');

const JSON_COLUMNS = new Set(['salary', 'score_json']);

const counts = sqlite
  .prepare('SELECT stage, COUNT(*) n FROM jobs GROUP BY stage ORDER BY n DESC')
  .all() as { stage: string; n: number }[];
const total = counts.reduce((s, r) => s + r.n, 0);
console.log('local funnel:', JSON.stringify(Object.fromEntries(counts.map((r) => [r.stage, r.n]))));
console.log(`total ${total.toLocaleString()} rows to migrate`);

if (DRY) {
  console.log('\n--dry-run, nothing sent');
  process.exit(0);
}

await migrate();
const sql = getSql();

const select = sqlite.prepare(
  `SELECT ${COLUMNS.join(', ')} FROM jobs ORDER BY rowid LIMIT ? OFFSET ?`,
);

let sent = 0;
let offset = 0;
const t0 = Date.now();

for (;;) {
  const rows = select.all(BATCH, offset) as unknown as Row[];
  if (!rows.length) break;
  offset += rows.length;

  // Split further if this batch carries large descriptions.
  let chunk: Row[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!chunk.length) return;
    await push(chunk);
    sent += chunk.length;
    chunk = [];
    bytes = 0;
  };

  for (const row of rows) {
    const size = (row.description?.length ?? 0) + 500;
    if (chunk.length && bytes + size > MAX_BATCH_BYTES) await flush();
    chunk.push(row);
    bytes += size;
  }
  await flush();

  const pct = ((sent / total) * 100).toFixed(1);
  process.stdout.write(`\r  ${sent.toLocaleString()}/${total.toLocaleString()} (${pct}%)`);
}
process.stdout.write('\n');

async function push(rows: readonly Row[]): Promise<void> {
  const values: unknown[] = [];
  const tuples = rows.map((row, i) => {
    const base = i * COLUMNS.length;
    const placeholders = COLUMNS.map((col, j) => {
      let v: unknown = row[col as keyof Row];
      if (col === 'remote' || col === 'is_recruiter') v = v === null ? null : Boolean(v);
      if (col === 'stage') v = STAGE_MAP[String(v)] ?? v;
      values.push(v);
      return JSON_COLUMNS.has(col) ? `$${base + j + 1}::jsonb` : `$${base + j + 1}`;
    });
    return `(${placeholders.join(',')})`;
  });

  await sql.query(
    `INSERT INTO jobs (${COLUMNS.join(', ')}) VALUES ${tuples.join(',')}
     ON CONFLICT (url) DO UPDATE SET ${UPDATES}`,
    values,
  );
}

// Cost history, so the dashboard's spend tile reflects what has actually been spent.
const runs = sqlite.prepare('SELECT kind, started_at, finished_at, stats FROM runs').all() as
  { kind: string; started_at: string; finished_at: string | null; stats: string | null }[];
for (const r of runs) {
  await sql`
    INSERT INTO runs (kind, started_at, finished_at, stats)
    VALUES (${r.kind}, ${r.started_at}, ${r.finished_at}, ${r.stats}::jsonb)`;
}

const labels = sqlite.prepare('SELECT url, verdict, note, created_at FROM labels').all() as
  { url: string; verdict: string; note: string | null; created_at: string }[];
for (const l of labels) {
  await sql`
    INSERT INTO labels (url, verdict, note, created_at)
    VALUES (${l.url}, ${l.verdict}, ${l.note}, ${l.created_at})
    ON CONFLICT (url) DO UPDATE SET verdict = excluded.verdict, note = excluded.note`;
}

const remote = (await sql`SELECT stage, count(*)::int n FROM jobs GROUP BY stage ORDER BY n DESC`) as
  { stage: string; n: number }[];
console.log(`\nmigrated ${sent.toLocaleString()} jobs, ${runs.length} runs, ${labels.length} labels in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('neon funnel:', JSON.stringify(Object.fromEntries(remote.map((r) => [r.stage, r.n]))));
