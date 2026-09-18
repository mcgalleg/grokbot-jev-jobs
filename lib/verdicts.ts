/**
 * Verdict values live here rather than in app/actions.ts because a file with
 * the 'use server' directive may only export async functions. Exporting this
 * array from there type-checks and builds, then throws at runtime.
 */
export const VERDICTS = ['good', 'bad', 'applied', 'ignored'] as const;
export type Verdict = (typeof VERDICTS)[number];
