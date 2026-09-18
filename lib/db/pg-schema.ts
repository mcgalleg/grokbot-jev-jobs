import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Pipeline stages a job moves through.
 *  new            just ingested from the feed
 *  triaged        passed jev title triage (stage 1)
 *  triage_reject  jev said the title is not worth reading
 *  fetched        full description retrieved from the ATS (stage 2)
 *  scored         jev scored resume vs description (stage 3)
 *  expired        the posting left the board before we could read it
 *  unsupported    its ATS has no fetcher wired up, so it is terminal for now
 *  error          something failed; see `error`
 */
export const STAGES = [
  'new',
  'triaged',
  'triage_reject',
  'fetched',
  'scored',
  'expired',
  'unsupported',
  'error',
] as const;
export type Stage = (typeof STAGES)[number];

/**
 * The whole pipeline, in one table, in Neon.
 *
 * Postings that fail the stage 0 screen are never inserted — they are 94% of the
 * feed, and storing them would mean writing 1.4M rows a day to learn nothing.
 */
export const jobs = pgTable(
  'jobs',
  {
    // ---- from the aggregator feed ----
    url: text('url').primaryKey(),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location'),
    ats: text('ats'),
    skillLevel: text('skill_level'),
    remote: boolean('remote'),
    isRecruiter: boolean('is_recruiter'),
    /** Market estimate from the aggregator's lookup table, NOT the posting's stated pay. */
    salary: jsonb('salary'),
    postedAt: text('updated_at'),
    firstSeen: text('first_seen'),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),

    // ---- pipeline ----
    stage: text('stage').notNull().default('new'),
    error: text('error'),

    // ---- stage 1: jev title triage ----
    triageRole: text('triage_role'),
    triageRoleP: doublePrecision('triage_role_p'),
    triageSeniority: doublePrecision('triage_seniority'),
    triageWorthP: doublePrecision('triage_worth_p'),
    triageConfidence: doublePrecision('triage_confidence'),
    triagedAt: text('triaged_at'),

    // ---- stage 2: description ----
    description: text('description'),
    descriptionChars: integer('description_chars'),
    fetchedAt: text('fetched_at'),

    // ---- stage 3: jev deep score ----
    fitScore: doublePrecision('fit_score'),
    fitConfidence: doublePrecision('fit_confidence'),
    blockerP: doublePrecision('blocker_p'),
    scoreJson: jsonb('score_json'),
    scoredAt: text('scored_at'),
  },
  (t) => [
    index('jobs_stage_idx').on(t.stage),
    index('jobs_fit_idx').on(t.fitScore),
    index('jobs_company_idx').on(t.company),
    // Stage 2 selects pending rows ordered by company so board caches hit.
    index('jobs_stage_company_idx').on(t.stage, t.company),
  ],
);

/** What you did about a scored job, so the open list can stop showing it. */
export const labels = pgTable('labels', {
  url: text('url').primaryKey(),
  verdict: text('verdict').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per stage run, so cost and volume are auditable. */
export const runs = pgTable(
  'runs',
  {
    id: serial('id').primaryKey(),
    kind: text('kind').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    stats: jsonb('stats'),
  },
  (t) => [index('runs_kind_idx').on(t.kind, t.finishedAt)],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Label = typeof labels.$inferSelect;
