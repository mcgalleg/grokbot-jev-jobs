import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

const DB_PATH = process.env.JOB_DB_PATH ?? resolve(process.cwd(), 'data/jobs.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');
/**
 * Wait for a writer rather than failing instantly.
 *
 * WAL lets readers run during a write, but two writers still collide, and the
 * pipeline stages are meant to be run alongside each other — `pnpm sync` during
 * a long `pnpm triage` is the normal case, not an edge case. Without this,
 * SQLite returns SQLITE_BUSY immediately and the second script dies with
 * 'database is locked'. Observed in practice.
 */
sqlite.exec('PRAGMA busy_timeout = 15000');

/**
 * Drizzle has no driver for Node's built-in sqlite yet, so we bridge through
 * sqlite-proxy. The proxy wants positional rows, and node:sqlite hands back
 * objects, so we unwrap them in column order.
 */
export const db = drizzle(
  async (query, params, method) => {
    const stmt = sqlite.prepare(query);
    if (method === 'run') {
      stmt.run(...(params as never[]));
      return { rows: [] };
    }
    const records = stmt.all(...(params as never[])) as Record<string, unknown>[];
    const rows = records.map((r) => Object.values(r));
    return method === 'get' ? { rows: rows[0] ?? [] } : { rows };
  },
  { schema },
);

/** Create tables if they are missing. Cheap enough to call on every script start. */
export function migrate(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      location TEXT,
      ats TEXT,
      skill_level TEXT,
      remote INTEGER,
      is_recruiter INTEGER,
      salary TEXT,
      updated_at TEXT,
      first_seen TEXT,
      ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      stage TEXT NOT NULL DEFAULT 'new',
      error TEXT,
      triage_role TEXT,
      triage_role_p REAL,
      triage_seniority REAL,
      triage_worth_p REAL,
      triage_confidence REAL,
      triaged_at TEXT,
      description TEXT,
      description_chars INTEGER,
      fetched_at TEXT,
      fit_score REAL,
      fit_confidence REAL,
      blocker_p REAL,
      score_json TEXT,
      scored_at TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_stage_idx ON jobs(stage);
    CREATE INDEX IF NOT EXISTS jobs_fit_idx ON jobs(fit_score);
    CREATE INDEX IF NOT EXISTS jobs_company_idx ON jobs(company);

    CREATE TABLE IF NOT EXISTS labels (
      url TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      stats TEXT
    );
  `);
}

export { schema };
