/**
 * Shared shape for the four pipeline stages.
 *
 * The same functions run from the CLI (`pnpm triage`) and from the cron route,
 * so there is exactly one implementation of each stage to reason about.
 */
export interface StageOpts {
  limit?: number;
  concurrency?: number;
  /**
   * Epoch ms after which a stage should stop starting new work and return what
   * it has. Every stage commits per row and selects only unprocessed rows, so
   * stopping early costs time, never work.
   */
  deadline?: number;
  /** Progress and summary lines. Defaults to console.log; the cron route collects them. */
  log?: (line: string) => void;
}

/** True when the deadline has passed. A missing deadline never expires. */
export const expired = (deadline?: number) => deadline !== undefined && Date.now() >= deadline;
