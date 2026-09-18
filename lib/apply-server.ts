import 'server-only';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { ensureApplySchema, getDb } from '@/lib/db/pg';
import { applyAttempts, applies, jobs, labels } from '@/lib/db/pg-schema';
import { IGNORED } from '@/lib/verdicts';
import {
  type ApplyRequestPayload,
  type ApplyStatus,
  type RudyCallbackBody,
  type TerminalApplyStatus,
  buildApplyRequestPayload,
  canStartApply,
  decideCallback,
} from '@/lib/apply';

const WEBHOOK_TIMEOUT_MS = 8_000;

export type RequestApplyResult =
  | { ok: true; attemptId: string; status: 'applying' }
  | {
      ok: false;
      code: 'already-applying' | 'already-applied' | 'not-found' | 'misconfigured' | 'webhook-failed';
      message: string;
      attemptId?: string;
      status?: ApplyStatus;
    };

export async function requestApply(jobUrl: string): Promise<RequestApplyResult> {
  if (!jobUrl) throw new Error('url is required');
  await ensureApplySchema();

  const db = getDb();
  const [job] = await db
    .select({
      url: jobs.url,
      title: jobs.title,
      company: jobs.company,
      location: jobs.location,
      ats: jobs.ats,
      fitScore: jobs.fitScore,
      stage: jobs.stage,
    })
    .from(jobs)
    .where(eq(jobs.url, jobUrl))
    .limit(1);

  if (!job || job.stage !== 'scored') {
    return { ok: false, code: 'not-found', message: 'scored job not found' };
  }

  const [current] = await db.select().from(applies).where(eq(applies.url, jobUrl)).limit(1);
  if (current?.status === 'applying') {
    return {
      ok: false,
      code: 'already-applying',
      message: 'an apply is already in flight for this posting',
      attemptId: current.attemptId,
      status: 'applying',
    };
  }
  if (current?.status === 'applied') {
    return {
      ok: false,
      code: 'already-applied',
      message: 'Rudy already reported this posting as applied',
      attemptId: current.attemptId,
      status: 'applied',
    };
  }
  if (current && !canStartApply(current.status as ApplyStatus)) {
    return {
      ok: false,
      code: 'already-applying',
      message: `cannot start an apply from ${current.status}`,
      attemptId: current.attemptId,
      status: current.status as ApplyStatus,
    };
  }

  const webhookUrl = process.env.RUDY_APPLY_WEBHOOK_URL?.trim();
  const webhookSecret = process.env.RUDY_APPLY_WEBHOOK_SECRET?.trim();
  if (!webhookUrl || !webhookSecret) {
    return {
      ok: false,
      code: 'misconfigured',
      message: 'RUDY_APPLY_WEBHOOK_URL and RUDY_APPLY_WEBHOOK_SECRET must be set',
    };
  }

  const attemptId = randomUUID();
  const requestedAt = new Date();
  const payload = buildApplyRequestPayload({
    attemptId,
    jobUrl,
    title: job.title.trim(),
    company: job.company,
    ats: job.ats,
    location: job.location,
    fitScore: job.fitScore == null ? null : Number(job.fitScore),
    generatedAt: requestedAt.toISOString(),
  });

  try {
    await db.insert(applyAttempts).values({
      id: attemptId,
      jobUrl,
      status: 'applying',
      requestedAt,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        ok: false,
        code: 'already-applying',
        message: 'an apply is already in flight for this posting',
        status: 'applying',
      };
    }
    throw error;
  }

  await db
    .insert(applies)
    .values({
      url: jobUrl,
      attemptId,
      status: 'applying',
      detail: null,
      requestedAt,
      completedAt: null,
    })
    .onConflictDoUpdate({
      target: applies.url,
      set: {
        attemptId,
        status: 'applying',
        detail: null,
        requestedAt,
        completedAt: null,
      },
    });

  // Applying is interest: an Ignore set earlier should not keep hiding the row
  // from Open once the user has asked Rudy to submit.
  await db.delete(labels).where(eq(labels.url, jobUrl));

  try {
    await postRudyWebhook(webhookUrl, webhookSecret, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await settleAttempt(attemptId, jobUrl, 'failed', message.slice(0, 2000), new Date());
    revalidatePath('/');
    return { ok: false, code: 'webhook-failed', message, attemptId, status: 'failed' };
  }

  revalidatePath('/');
  return { ok: true, attemptId, status: 'applying' };
}

export async function setIgnored(jobUrl: string, ignored: boolean): Promise<void> {
  if (!jobUrl) throw new Error('url is required');
  const db = getDb();
  if (ignored) {
    await db
      .insert(labels)
      .values({ url: jobUrl, verdict: IGNORED })
      .onConflictDoUpdate({
        target: labels.url,
        set: { verdict: IGNORED },
      });
  } else {
    await db.delete(labels).where(eq(labels.url, jobUrl));
  }
  revalidatePath('/');
}

export async function applyRudyCallback(body: RudyCallbackBody): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  await ensureApplySchema();
  const db = getDb();

  const [active] = await db.select().from(applies).where(eq(applies.url, body.jobUrl)).limit(1);
  const decision = decideCallback({
    activeAttemptId: active?.attemptId ?? null,
    activeJobUrl: active?.url ?? null,
    activeStatus: (active?.status as ApplyStatus | undefined) ?? null,
    attemptId: body.attemptId,
    jobUrl: body.jobUrl,
    nextStatus: body.status,
  });

  if (decision.action === 'reject') {
    return { status: decision.status, body: { ok: false, error: decision.error } };
  }
  if (decision.action === 'idempotent') {
    return {
      status: 200,
      body: {
        ok: true,
        idempotent: true,
        attemptId: body.attemptId,
        status: body.status,
      },
    };
  }

  const occurredAt = new Date(body.occurredAt);
  await settleAttempt(body.attemptId, body.jobUrl, body.status, body.detail, occurredAt);
  revalidatePath('/');
  return {
    status: 200,
    body: { ok: true, attemptId: body.attemptId, status: body.status },
  };
}

async function settleAttempt(
  attemptId: string,
  jobUrl: string,
  status: TerminalApplyStatus,
  detail: string | null,
  occurredAt: Date,
): Promise<void> {
  const db = getDb();
  await db
    .update(applyAttempts)
    .set({ status, detail, completedAt: occurredAt })
    .where(and(eq(applyAttempts.id, attemptId), eq(applyAttempts.status, 'applying')));
  await db
    .update(applies)
    .set({ status, detail, completedAt: occurredAt })
    .where(and(eq(applies.url, jobUrl), eq(applies.attemptId, attemptId), eq(applies.status, 'applying')));
}

async function postRudyWebhook(
  url: string,
  secret: string,
  payload: ApplyRequestPayload,
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!response.ok) {
    const snippet = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`Rudy webhook HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  if (code === '23505') return true;
  const message = 'message' in error ? String(error.message) : '';
  return /duplicate key|unique constraint|apply_attempts_one_applying/i.test(message);
}
