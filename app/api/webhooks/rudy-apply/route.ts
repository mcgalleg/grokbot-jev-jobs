import { applyRudyCallback } from '@/lib/apply-server';
import { callbackSecretFrom, parseCallbackBody, secretsMatch } from '@/lib/apply';

export const dynamic = 'force-dynamic';

/**
 * Write-back from Resume Rudy.
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
  const expected = process.env.RUDY_CALLBACK_SECRET;
  if (!expected) {
    return Response.json({ ok: false, error: 'RUDY_CALLBACK_SECRET is not set' }, { status: 503 });
  }
  if (!secretsMatch(callbackSecretFrom(req.headers), expected)) {
    return Response.json({ ok: false, error: 'unauthorised' }, { status: 401 });
  }

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
