'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/pg';
import { labels } from '@/lib/db/pg-schema';
import { VERDICTS, type Verdict } from '@/lib/verdicts';

/**
 * Mark what you did about a posting, so it leaves the open list.
 *
 * Writes to Neon, which is the only home for these — you press these buttons on
 * the deployed dashboard, so keeping a second copy in local SQLite would
 * diverge immediately.
 *
 * The deployment is guarded by Vercel Authentication, so every request that
 * reaches here is already you. Opening it up to anyone else would need an
 * ownership check on this row first.
 */
export async function setVerdict(url: string, verdict: Verdict | null, note?: string) {
  if (!url) throw new Error('url is required');
  if (verdict !== null && !VERDICTS.includes(verdict)) throw new Error(`bad verdict: ${verdict}`);

  const db = getDb();
  if (verdict === null) {
    await db.delete(labels).where(eq(labels.url, url));
  } else {
    await db
      .insert(labels)
      .values({ url, verdict, note: note ?? null })
      .onConflictDoUpdate({
        target: labels.url,
        set: { verdict, note: note ?? null },
      });
  }
  revalidatePath('/');
}
