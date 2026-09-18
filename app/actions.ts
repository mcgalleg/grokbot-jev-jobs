'use server';

import { requestApply as startApply, setIgnored as writeIgnored } from '@/lib/apply-server';

/**
 * Start an automated application. Creates an attempt, sets status to
 * `applying`, POSTs the universal CV + cover paths to Resume Rudy, and
 * returns. Applied is set later, only if Rudy writes back success.
 */
export async function requestApply(url: string) {
  return startApply(url);
}

/**
 * Mark a posting as not interesting, or clear that mark. Toggle only —
 * this does not talk to Rudy and does not change apply state.
 */
export async function setIgnored(url: string, ignored: boolean) {
  await writeIgnored(url, ignored);
}
