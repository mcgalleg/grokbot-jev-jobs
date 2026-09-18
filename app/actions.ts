'use server';

import { revalidatePath } from 'next/cache';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/pg';
import { labels } from '@/lib/db/pg-schema';
import { VERDICTS, type Verdict } from '@/lib/verdicts';

/**
 * Record a verdict on a scored job. These labels are the whole point of the
 * exercise: they are what tells you whether jev's ranking matches yours.
 *
 * Writes to Neon, which is the only home for verdicts — you press these buttons
 * on the deployed dashboard, so keeping a second copy in local SQLite would
 * diverge immediately. `pnpm publish` copies them back down one-way.
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
