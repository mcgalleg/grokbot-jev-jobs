import { authorizeRudy } from '@/lib/apply';
import { PageBrainConfigError, logPageBrainCall, runPageBrain } from '@/lib/apply-page-brain';
import { parsePageBrainBody } from '@/lib/page-brain';

export const dynamic = 'force-dynamic';
// Jev answers in about a second; the budget covers askJev's retries with backoff.
export const maxDuration = 60;

/**
 * The page brain for Resume Rudy, mid-apply.
 *
 *   POST /api/rudy/page-brain
 *   Authorization: Bearer ${RUDY_CALLBACK_SECRET}     (or x-rudy-secret)
 *   x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}   (while behind Vercel Authentication)
 *
 *   { "mode": "next-action" | "knock-out" | "field-map" | "outcome", ...fields }
 *
 * Responds with `{ mode, answers, confidence, inputTokens, costUsd, latencyMs }`,
 * the same object the local CLI prints. Field shapes per mode are in
 * lib/page-brain.ts and the README. 400 is a bad request, 503 is a setup
 * problem on our side, 502 is Jev failing after retries.
 */
export async function POST(req: Request) {
  const denied = authorizeRudy(req.headers);
  if (denied) return denied;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'body must be JSON' }, { status: 400 });
  }
  const parsed = parsePageBrainBody(json);
  if (!parsed.ok) {
    return Response.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  const started = Date.now();
  try {
    const result = await runPageBrain(parsed.input);
    const latencyMs = Date.now() - started;
    await logPageBrainCall({ source: 'http', input: parsed.input, result, latencyMs });
    return Response.json({ ...result, latencyMs });
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    await logPageBrainCall({ source: 'http', input: parsed.input, error: message, latencyMs });
    const status = error instanceof PageBrainConfigError ? 503 : 502;
    return Response.json({ ok: false, error: message, mode: parsed.input.mode }, { status });
  }
}
