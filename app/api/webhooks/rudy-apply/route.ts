import { applyRudyCallback, readRudyApplyStatus } from '@/lib/apply-server';
import { callbackSecretFrom, parseCallbackBody, parseRudyStatusQuery, secretsMatch } from '@/lib/apply';

export const dynamic = 'force-dynamic';

/**
 * Write-back from Resume Rudy, plus a pre-Submit status check.
 *
 * The dashboard is behind Vercel Authentication, so there is no session for
 * Rudy to present. This route is gated by `RUDY_CALLBACK_SECRET` instead:
 *
 *   Authorization: Bearer ${RUDY_CALLBACK_SECRET}
 *   — or —
 *   x-rudy-secret: ${RUDY_CALLBACK_SECRET}
 *
 * If the deployment still sits behind Vercel Authentication, Rudy must also
 * send `x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}` (or
 * use the query parameter of the same name, which `callbackUrl` includes
 * when that env var is set).
 */
export async function POST(req: Request) {
  const denied = authorizeRudy(req);
  if (denied) return denied;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }

  const parsed = parseCallbackBody(json);
  if (!parsed.ok) {
    return Response.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  const result = await applyRudyCallback(parsed.body);
  return Response.json(result.body, { status: result.status });
}

/**
 * Current apply status for one attempt or posting. Rudy calls this immediately
 * before Submit so a parallel runner or a late knock-out can abort.
 *
 *   GET /api/webhooks/rudy-apply?attemptId=<uuid>
 *   GET /api/webhooks/rudy-apply?jobUrl=<url>
 *
 * Auth is the same Bearer / x-rudy-secret gate as POST. Response shape is
 * `{ status, detail, attemptId }`.
 */
export async function GET(req: Request) {
  const denied = authorizeRudy(req);
  if (denied) return denied;

  const parsed = parseRudyStatusQuery(new URL(req.url).searchParams);
  if (!parsed.ok) {
    return Response.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  const row = await readRudyApplyStatus({
    attemptId: parsed.attemptId,
    jobUrl: parsed.jobUrl,
  });
  if (row.conflict) {
    return Response.json(
      { ok: false, error: 'attemptId does not match the active attempt for this jobUrl' },
      { status: 409 },
    );
  }

  const body = { status: row.status, detail: row.detail, attemptId: row.attemptId };
  return Response.json(body, { status: row.found ? 200 : 404 });
}

function authorizeRudy(req: Request): Response | null {
  const expected = process.env.RUDY_CALLBACK_SECRET;
  if (!expected) {
    return Response.json({ ok: false, error: 'RUDY_CALLBACK_SECRET is not set' }, { status: 503 });
  }
  if (!secretsMatch(callbackSecretFrom(req.headers), expected)) {
    return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 });
  }
  return null;
}
