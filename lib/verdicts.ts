/**
 * The only user-set label left. Applied is not a label — it is a write-back
 * from Resume Rudy, see lib/apply.ts.
 *
 * Lives here rather than in app/actions.ts because a file with the
 * 'use server' directive may only export async functions.
 */
export const IGNORED = 'ignored' as const;
