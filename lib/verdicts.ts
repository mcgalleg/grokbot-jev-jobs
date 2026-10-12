/**
 * The user-set ignore label. Applied is not a label — it is a write-back
 * from Resume Rudy, see lib/apply.ts.
 *
 * Lives here rather than in app/actions.ts because a file with the
 * 'use server' directive may only export async functions.
 */
export const IGNORED = 'ignored' as const;

/**
 * Written when the user un-ignores a posting, instead of deleting the label row.
 * It is not an ignore (nothing filters on it), but its presence stops the stale
 * sweep from ignoring the posting again. See lib/stages/stale.ts.
 */
export const RESTORED = 'restored' as const;
