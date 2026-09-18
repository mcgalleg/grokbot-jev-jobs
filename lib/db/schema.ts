import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Pipeline stages a job moves through.
 *  new            just ingested from the feed
 *  screened_out   failed the deterministic code filter (stage 0)
 *  triaged        passed jev title triage (stage 1)
 *  triage_reject  jev said the title is not worth reading
 *  fetched        full description retrieved from the ATS (stage 2)
 *  scored         jev scored resume vs description (stage 3)
 *  error          something failed; see `error`
 */
export const STAGES = [
  'new',
  'screened_out',
  'triaged',
  'triage_reject',
  'fetched',
  'scored',
  'error',
] as const;
export type Stage = (typeof STAGES)[number];

export const jobs = sqliteTable(
  'jobs',
  {
    // ---- from the aggregator feed ----
    url: text('url').primaryKey(),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location'),
    ats: text('ats'),
    skillLevel: text('skill_level'),
    remote: integer('remote', { mode: 'boolean' }),
    isRecruiter: integer('is_recruiter', { mode: 'boolean' }),
    salary: text('salary'),
    postedAt: text('updated_at'),
    firstSeen: text('first_seen'),
    ingestedAt: text('ingested_at').notNull().default(sql`CURRENT_TIMESTAMP`),

    // ---- pipeline ----
    stage: text('stage').notNull().default('new'),
    error: text('error'),

    // ---- stage 1: jev title triage ----
    triageRole: text('triage_role'),
    triageRoleP: real('triage_role_p'),
    triageSeniority: real('triage_seniority'),
    triageWorthP: real('triage_worth_p'),
    triageConfidence: real('triage_confidence'),
    triagedAt: text('triaged_at'),

    // ---- stage 2: description ----
    description: text('description'),
    descriptionChars: integer('description_chars'),
    fetchedAt: text('fetched_at'),

    // ---- stage 3: jev deep score ----
    fitScore: real('fit_score'),
    fitConfidence: real('fit_confidence'),
    blockerP: real('blocker_p'),
    scoreJson: text('score_json'),
    scoredAt: text('scored_at'),
  },
  (t) => [
    index('jobs_stage_idx').on(t.stage),
    index('jobs_fit_idx').on(t.fitScore),
    index('jobs_company_idx').on(t.company),
  ],
);

/** Your verdict on a scored job. This is the labelled set that tells you if jev is right. */
export const labels = sqliteTable('labels', {
  url: text('url').primaryKey(),
  verdict: text('verdict').notNull(), // 'good' | 'bad' | 'applied' | 'ignored'
  note: text('note'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** One row per pipeline script run, so cost and volume are auditable. */
export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  stats: text('stats'),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Label = typeof labels.$inferSelect;
