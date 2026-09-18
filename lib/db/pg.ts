import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as pgSchema from './pg-schema';

/**
 * The database. One Neon Postgres, shared by the pipeline and the dashboard.
 *
 * Initialised lazily on purpose. `neon()` throws when DATABASE_URL is unset, and
 * Next evaluates top-level module code during `next build`, so a module-level
 * client would break a deploy made before the env var is attached.
 *
 * Deliberately a plain function rather than a Proxy: libraries that introspect a
 * db object are silently broken by one, and the failure mode is a hang with no
 * error.
 */
function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Locally: `vercel env pull .env.local`. ' +
        'On Vercel it is injected by the Neon Marketplace integration.',
    );
  }
  return url;
}

let cachedSql: NeonQueryFunction<false, false> | null = null;
let cachedDb: ReturnType<typeof drizzle> | null = null;

/** Raw tagged-template SQL. Values are parameterised, never interpolated. */
export function getSql(): NeonQueryFunction<false, false> {
  if (!cachedSql) cachedSql = neon(connectionString());
  return cachedSql;
}

export function getDb() {
  if (!cachedDb) cachedDb = drizzle(getSql(), { schema: pgSchema });
  return cachedDb;
}

/** True when a connection string is present, so callers can degrade instead of throw. */
export const hasDatabase = () => Boolean(process.env.DATABASE_URL);

export { pgSchema };

/**
 * Create the schema if it is missing.
 *
 * Called by the pipeline stages, never on the dashboard's read path — that would
 * spend an HTTP round trip on DDL before every render. Raw SQL rather than
 * drizzle-kit migrations because a three-table schema does not need a migration
 * history, and the cron function should not carry a migration runner.
 */
export async function migrate(): Promise<void> {
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS jobs (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      company TEXT NOT NULL
    )`;

  // Additive, so this doubles as the upgrade path: a table created by an earlier
  // shape gains whatever it is missing instead of needing to be dropped.
  const columns: [string, string][] = [
    ['location', 'TEXT'],
    ['ats', 'TEXT'],
    ['skill_level', 'TEXT'],
    ['remote', 'BOOLEAN'],
    ['is_recruiter', 'BOOLEAN'],
    ['salary', 'JSONB'],
    ['updated_at', 'TEXT'],
    ['first_seen', 'TEXT'],
    ['ingested_at', 'TIMESTAMPTZ NOT NULL DEFAULT now()'],
    ['stage', "TEXT NOT NULL DEFAULT 'new'"],
    ['error', 'TEXT'],
    ['triage_role', 'TEXT'],
    ['triage_role_p', 'DOUBLE PRECISION'],
    ['triage_seniority', 'DOUBLE PRECISION'],
    ['triage_worth_p', 'DOUBLE PRECISION'],
    ['triage_confidence', 'DOUBLE PRECISION'],
    ['triaged_at', 'TEXT'],
    ['description', 'TEXT'],
    ['description_chars', 'INTEGER'],
    ['fetched_at', 'TEXT'],
    ['fit_score', 'DOUBLE PRECISION'],
    ['fit_confidence', 'DOUBLE PRECISION'],
    ['blocker_p', 'DOUBLE PRECISION'],
    ['score_json', 'JSONB'],
    ['scored_at', 'TEXT'],
  ];
  // One statement, not one per column: this runs on every cron invocation, and
  // 25 separate round trips to Neon is a second of the time budget spent on
  // nothing.
  await sql.query(
    `ALTER TABLE jobs ${columns.map(([n, t]) => `ADD COLUMN IF NOT EXISTS ${n} ${t}`).join(', ')}`,
  );
  // An earlier shape held only scored rows, so fit_score was NOT NULL. It now
  // holds every stage, and most rows have no score.
  await sql`ALTER TABLE jobs ALTER COLUMN fit_score DROP NOT NULL`;

  await sql`CREATE INDEX IF NOT EXISTS jobs_stage_idx ON jobs(stage)`;
  await sql`CREATE INDEX IF NOT EXISTS jobs_fit_idx ON jobs(fit_score)`;
  await sql`CREATE INDEX IF NOT EXISTS jobs_company_idx ON jobs(company)`;
  await sql`CREATE INDEX IF NOT EXISTS jobs_stage_company_idx ON jobs(stage, company)`;

  await sql`
    CREATE TABLE IF NOT EXISTS labels (
      url TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      stats JSONB
    )`;
  await sql`CREATE INDEX IF NOT EXISTS runs_kind_idx ON runs(kind, finished_at)`;
}

/** Record a finished stage run. Cost and volume stay auditable without the Vercel dashboard. */
export async function recordRun(
  kind: string,
  startedAt: Date,
  stats: unknown,
): Promise<void> {
  const sql = getSql();
  await sql`
    INSERT INTO runs (kind, started_at, finished_at, stats)
    VALUES (${kind}, ${startedAt.toISOString()}, now(), ${JSON.stringify(stats)}::jsonb)`;
}
