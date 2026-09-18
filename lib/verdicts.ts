/**
 * What you did about a posting. Not a judgement of jev's score — we take that
 * at face value — just a record of which rows you have dealt with, so the list
 * can stop showing them.
 *
 * These live here rather than in app/actions.ts because a file with the
 * 'use server' directive may only export async functions. Exporting this array
 * from there type-checks and builds, then throws at runtime.
 */
export const VERDICTS = ['applied', 'ignored'] as const;
export type Verdict = (typeof VERDICTS)[number];
