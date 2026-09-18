'use server';

import { connection } from 'next/server';
import {
  readApplyStatus,
  requestApply as startApply,
  setIgnored as writeIgnored,
} from '@/lib/apply-server';

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

/**
 * Latest apply pointer for one posting. Used by the list while status is
 * `applying`, because `revalidatePath` cannot overwrite the row's local state.
 *
 * `connection()` marks the read as request-time so a poll cannot reuse a
 * cached `applying` result after Rudy has already written back.
 */
export async function getApplyStatus(url: string) {
  await connection();
  return readApplyStatus(url);
}
