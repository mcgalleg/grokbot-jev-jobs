/**
 * Apply lifecycle for a scored posting.
 *
 * Ignore stays a label (`labels.verdict = 'ignored'`). Apply is a separate
 * machine: the dashboard starts an attempt, Resume Rudy runs it, and only a
 * secret-gated callback may move the attempt to a terminal status. There is
 * no manual Applied toggle.
 *
 *   unset ──Apply──► applying ──callback──► applied | failed | blocked | skipped
 *                       ▲                         │
 *                       └──────── retry ──────────┘  (failed / blocked / skipped)
 *
 * A later `applied` for the same attemptId+jobUrl overwrites blocked / failed /
 * skipped (confirmation email / truth wins). Those statuses never overwrite
 * `applied`.
 *
 * A second Apply while `applying` is refused. `applied` is terminal for the
 * posting — Rudy already reported success.
 */

export const APPLY_STATUSES = ['applying', 'applied', 'failed', 'blocked', 'skipped'] as const;
export type ApplyStatus = (typeof APPLY_STATUSES)[number];

export const TERMINAL_APPLY_STATUSES = ['applied', 'failed', 'blocked', 'skipped'] as const;
export type TerminalApplyStatus = (typeof TERMINAL_APPLY_STATUSES)[number];

export const RETRYABLE_APPLY_STATUSES = ['failed', 'blocked', 'skipped'] as const;
export type RetryableApplyStatus = (typeof RETRYABLE_APPLY_STATUSES)[number];

export const WEBHOOK_ATS = ['Greenhouse', 'Ashby', 'Workday', 'Lever'] as const;
export type WebhookAts = (typeof WEBHOOK_ATS)[number];

/** Paths on Mike's machine. Rudy reads these; the deployment never opens them. */
export const UNIVERSAL_RESUME_PATH = '/home/mike/Projects/grokbot-jev-jobs/output/mike-gallegos-cv.pdf';
export const UNIVERSAL_COVER_PATH =
  '/home/mike/Projects/grokbot-jev-jobs/output/universal-cover-letter.pdf';

export const APPLY_SOURCE = 'jev-job-search';
export const APPLY_EVENT = 'apply-request';
export const CALLBACK_PATH = '/api/webhooks/rudy-apply';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isApplyStatus(value: string): value is ApplyStatus {
  return (APPLY_STATUSES as readonly string[]).includes(value);
}

export function isTerminalApplyStatus(value: string): value is TerminalApplyStatus {
  return (TERMINAL_APPLY_STATUSES as readonly string[]).includes(value);
}

export function isRetryableApplyStatus(value: string): value is RetryableApplyStatus {
  return (RETRYABLE_APPLY_STATUSES as readonly string[]).includes(value);
}

/**
 * Statuses `settleAttempt` may leave, given the inbound terminal status.
 * `applied` may correct a same-attempt blocked/failed/skipped; a lesser
 * terminal may only settle from `applying`, never from `applied`.
 */
export function settleFromStatuses(nextStatus: TerminalApplyStatus): readonly ApplyStatus[] {
  if (nextStatus === 'applied') {
    return ['applying', 'blocked', 'failed', 'skipped'];
  }
  return ['applying'];
}

/** Apply is allowed when there is no attempt, or the last one can be retried. */
export function canStartApply(status: ApplyStatus | null | undefined): boolean {
  return status == null || isRetryableApplyStatus(status);
}

/**
 * Rudy's `detail` (knock-out quote, webhook error, skip reason) belongs next
 * to these outcomes in the list. Applying is a spinner; Applied is success
 * without a reason line.
 */
export function shouldShowApplyDetail(status: ApplyStatus | null | undefined): boolean {
  return status === 'failed' || status === 'blocked' || status === 'skipped';
}

/**
 * Title-row chip: Applied / Failed / Blocked / Skipped.
 * Applying is owned by the Apply button so the row never shows two spinners.
 */
export function shouldShowApplyStatusBadge(
  status: ApplyStatus | null | undefined,
): status is Exclude<ApplyStatus, 'applying'> {
  return status != null && status !== 'applying';
}

export type ApplyPointer = { status: ApplyStatus | null; detail: string | null };

export type ApplyPollTick =
  | { action: 'continue' }
  | { action: 'settle'; status: ApplyStatus | null; detail: string | null };

/**
 * A poll result that should stop the in-flight spinner and refresh the list.
 * `null` means the apply pointer is gone — also stop spinning.
 */
export function decideApplyPollTick(next: ApplyPointer): ApplyPollTick {
  if (next.status === 'applying') return { action: 'continue' };
  return { action: 'settle', status: next.status, detail: next.detail };
}

/** URLs whose merged pointer is still `applying`, in stable order. */
export function applyingUrls(items: readonly { url: string; status: ApplyStatus | null }[]): string[] {
  return items.filter((item) => item.status === 'applying').map((item) => item.url);
}

export type ApplyPollBatch =
  | { action: 'continue' }
  | { action: 'settle'; settled: Record<string, ApplyPointer> };

/**
 * One list-level poll over every in-flight Apply.
 *
 * A missing / null pointer is *not* a settle: the click may have flipped the
 * row to `applying` before Rudy (or even our insert) has written the row.
 * Only a real terminal status stops the spinner.
 */
export function decideApplyPollBatch(
  urls: readonly string[],
  next: Record<string, ApplyPointer>,
): ApplyPollBatch {
  const settled: Record<string, ApplyPointer> = {};
  for (const url of urls) {
    const pointer = next[url];
    if (!pointer || pointer.status == null || pointer.status === 'applying') continue;
    settled[url] = pointer;
  }
  return Object.keys(settled).length === 0 ? { action: 'continue' } : { action: 'settle', settled };
}

export function webhookAts(ats: string | null | undefined): WebhookAts | null {
  if (!ats) return null;
  return (WEBHOOK_ATS as readonly string[]).includes(ats) ? (ats as WebhookAts) : null;
}

/**
 * Public origin for `callbackUrl`.
 *
 *   1. APP_BASE_URL          — set this in production (stable custom domain)
 *   2. NEXT_PUBLIC_APP_URL   — same idea, if already used elsewhere
 *   3. https://$VERCEL_URL   — the deployment host Vercel injects
 *   4. http://localhost:3000 — local `pnpm dev`
 */
export type EnvMap = Record<string, string | undefined>;

export function resolveAppBaseUrl(env: EnvMap = process.env): string {
  const explicit = env.APP_BASE_URL ?? env.NEXT_PUBLIC_APP_URL;
  if (explicit?.trim()) return stripTrailingSlash(explicit.trim());
  const vercel = env.VERCEL_URL?.trim();
  if (vercel) {
    const host = vercel.replace(/^https?:\/\//, '');
    return `https://${host}`;
  }
  return 'http://localhost:3000';
}

/**
 * Write-back URL Rudy should POST to.
 *
 * When `VERCEL_AUTOMATION_BYPASS_SECRET` is set, it is appended as
 * `x-vercel-protection-bypass` so the request can reach a deployment that is
 * behind Vercel Authentication. The route still requires `RUDY_CALLBACK_SECRET`.
 */
export function buildCallbackUrl(env: EnvMap = process.env): string {
  const url = new URL(CALLBACK_PATH, `${resolveAppBaseUrl(env)}/`);
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (bypass) url.searchParams.set('x-vercel-protection-bypass', bypass);
  return url.toString();
}

export interface ApplyRequestPayload {
  source: typeof APPLY_SOURCE;
  event: typeof APPLY_EVENT;
  attemptId: string;
  jobUrl: string;
  title: string;
  company: string;
  ats: WebhookAts | null;
  location: string | null;
  fitScore: number | null;
  resumePath: typeof UNIVERSAL_RESUME_PATH;
  coverPath: typeof UNIVERSAL_COVER_PATH;
  callbackUrl: string;
  generatedAt: string;
}

export function buildApplyRequestPayload(input: {
  attemptId: string;
  jobUrl: string;
  title: string;
  company: string;
  ats: string | null;
  location: string | null;
  fitScore: number | null;
  generatedAt?: string;
  env?: EnvMap;
}): ApplyRequestPayload {
  return {
    source: APPLY_SOURCE,
    event: APPLY_EVENT,
    attemptId: input.attemptId,
    jobUrl: input.jobUrl,
    title: input.title,
    company: input.company,
    ats: webhookAts(input.ats),
    location: input.location,
    fitScore: input.fitScore,
    resumePath: UNIVERSAL_RESUME_PATH,
    coverPath: UNIVERSAL_COVER_PATH,
    callbackUrl: buildCallbackUrl(input.env),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

export interface RudyCallbackBody {
  attemptId: string;
  jobUrl: string;
  status: TerminalApplyStatus;
  detail: string | null;
  occurredAt: string;
}

export type ParsedCallbackBody = { ok: true; body: RudyCallbackBody } | { ok: false; error: string };

export function parseCallbackBody(input: unknown): ParsedCallbackBody {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const raw = input as Record<string, unknown>;

  if (typeof raw.attemptId !== 'string' || !UUID_RE.test(raw.attemptId)) {
    return { ok: false, error: 'attemptId must be a uuid' };
  }
  if (typeof raw.jobUrl !== 'string' || !/^https?:\/\//.test(raw.jobUrl)) {
    return { ok: false, error: 'jobUrl must be an http(s) url' };
  }
  if (typeof raw.status !== 'string' || !isTerminalApplyStatus(raw.status)) {
    return { ok: false, error: 'status must be applied|failed|blocked|skipped' };
  }
  if (raw.detail !== undefined && raw.detail !== null && typeof raw.detail !== 'string') {
    return { ok: false, error: 'detail must be a string when present' };
  }
  if (typeof raw.occurredAt !== 'string' || Number.isNaN(Date.parse(raw.occurredAt))) {
    return { ok: false, error: 'occurredAt must be an ISO-8601 timestamp' };
  }

  const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
  return {
    ok: true,
    body: {
      attemptId: raw.attemptId,
      jobUrl: raw.jobUrl,
      status: raw.status,
      detail: detail.length ? detail.slice(0, 2000) : null,
      occurredAt: raw.occurredAt,
    },
  };
}

/**
 * Inbound auth: `Authorization: Bearer ${RUDY_CALLBACK_SECRET}` or `x-rudy-secret`.
 * Bearer wins when both are sent.
 */
export function callbackSecretFrom(headers: Headers): string | null {
  const auth = headers.get('authorization');
  if (auth) {
    const match = /^Bearer\s+(\S+)/i.exec(auth.trim());
    if (match?.[1]) return match[1];
  }
  const named = headers.get('x-rudy-secret')?.trim();
  return named || null;
}

export function secretsMatch(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

export type CallbackDecision =
  | { action: 'accept' }
  | { action: 'idempotent' }
  | { action: 'reject'; status: number; error: string };

/**
 * Only the active attempt for that jobUrl may advance.
 *
 * From `applying`, any terminal status is accepted. A later `applied` for the
 * same attemptId+jobUrl may overwrite blocked / failed / skipped (truth wins).
 * A lesser terminal never overwrites `applied`. A duplicate of the same
 * terminal status is a no-op so Rudy can retry its write-back.
 */
export function decideCallback(input: {
  activeAttemptId: string | null;
  activeJobUrl: string | null;
  activeStatus: ApplyStatus | null;
  attemptId: string;
  jobUrl: string;
  nextStatus: TerminalApplyStatus;
}): CallbackDecision {
  if (!input.activeAttemptId || !input.activeJobUrl || !input.activeStatus) {
    return { action: 'reject', status: 404, error: 'no active apply attempt for this job' };
  }
  if (input.activeAttemptId !== input.attemptId || input.activeJobUrl !== input.jobUrl) {
    return {
      action: 'reject',
      status: 409,
      error: 'attemptId does not match the active attempt for this jobUrl',
    };
  }
  if (input.activeStatus === input.nextStatus) {
    return { action: 'idempotent' };
  }
  if (input.activeStatus === 'applying') {
    return { action: 'accept' };
  }
  if (input.nextStatus === 'applied' && isRetryableApplyStatus(input.activeStatus)) {
    return { action: 'accept' };
  }
  return {
    action: 'reject',
    status: 409,
    error: `cannot advance from ${input.activeStatus} to ${input.nextStatus}`,
  };
}

export type ParsedRudyStatusQuery =
  | { ok: true; attemptId?: string; jobUrl?: string }
  | { ok: false; error: string };

/**
 * Rudy's pre-Submit status check: `attemptId` and/or `jobUrl` query params.
 */
export function parseRudyStatusQuery(searchParams: URLSearchParams): ParsedRudyStatusQuery {
  const attemptId = searchParams.get('attemptId')?.trim() ?? '';
  const jobUrl = searchParams.get('jobUrl')?.trim() ?? '';
  if (!attemptId && !jobUrl) {
    return { ok: false, error: 'attemptId or jobUrl is required' };
  }
  if (attemptId && !UUID_RE.test(attemptId)) {
    return { ok: false, error: 'attemptId must be a uuid' };
  }
  if (jobUrl && !/^https?:\/\//.test(jobUrl)) {
    return { ok: false, error: 'jobUrl must be an http(s) url' };
  }
  return {
    ok: true,
    ...(attemptId ? { attemptId } : {}),
    ...(jobUrl ? { jobUrl } : {}),
  };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
