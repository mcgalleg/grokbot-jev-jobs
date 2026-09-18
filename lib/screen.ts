/**
 * Stage 0: the deterministic filter.
 *
 * Only hard facts live here — things jev would add nothing to. Everything that
 * is a judgement call (is this title actually relevant?) is left to jev, which
 * reads title, company and location together and is far less brittle than a
 * regex over titles.
 */
import type { FeedJob } from './feed';

export interface ScreenConfig {
  /** Keep remote roles. */
  allowRemote: boolean;
  /** Substrings that make an on-site location acceptable. Case-insensitive. */
  metroTerms: string[];
  /** Drop postings from recruiting agencies. */
  dropRecruiters: boolean;
  /**
   * Feed skill_level values to drop in code. Empty by default: that tag is a
   * weighted keyword score over the title, not a fact, so jev owns the call.
   */
  dropSkillLevels: string[];
}

export const DEFAULT_SCREEN: ScreenConfig = {
  allowRemote: true,
  metroTerms: [
    'colorado',
    ', co',
    'denver',
    'lakewood',
    'boulder',
    'golden',
    'aurora, co',
    'littleton',
    'englewood',
    'broomfield',
    'westminster',
  ],
  dropRecruiters: true,
  dropSkillLevels: [],
};

export type ScreenResult = { keep: true } | { keep: false; reason: string };

export function screen(job: FeedJob, cfg: ScreenConfig = DEFAULT_SCREEN): ScreenResult {
  if (!job.url || !job.title || !job.company) return { keep: false, reason: 'incomplete record' };

  // Location first: it is the dominant hard fact, so checking it first makes the
  // reason tally reflect what each later rule uniquely removes rather than
  // crediting the first rule in the list with everything it happened to catch.
  const location = (job.location ?? '').toLowerCase();
  const isRemote = job.remote === true || /\bremote\b|\banywhere\b/.test(location);
  const inMetro = cfg.metroTerms.some((term) => location.includes(term));
  if (!(cfg.allowRemote && isRemote) && !inMetro) return { keep: false, reason: 'location' };

  if (cfg.dropRecruiters && job.is_recruiter) return { keep: false, reason: 'recruiter' };

  // Off by default: seniority is a judgement, and judgements belong to jev.
  // `pnpm ingest --drop-junior-levels` re-enables the keyword tag, which costs
  // about $0.39 less per backfill. Measured on 250 postings that only this rule
  // removed, jev rejected all 250, so the tag is accurate but redundant.
  if (job.skill_level && cfg.dropSkillLevels.includes(job.skill_level)) {
    return { keep: false, reason: `skill_level=${job.skill_level}` };
  }

  return { keep: true };
}
