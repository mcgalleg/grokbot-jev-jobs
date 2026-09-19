/**
 * The page brain as a local CLI, for debugging and trying out a prompt change.
 *
 * Rudy does not use this: it calls POST /api/rudy/page-brain on the deployment,
 * which runs the same lib code as released from master. Calls made here are
 * logged to the same `page_brain_calls` table with source `cli`.
 *
 * Usage:
 *   pnpm apply:page-brain --mode knock-out --input ./payload.json
 *   cat payload.json | pnpm apply:page-brain --mode next-action
 *
 * The JSON body is the same as the route's; `mode` may be in the body instead
 * of --mode. Prints one JSON object to stdout, or `{ error }` to stderr with
 * exit code 1.
 */
import '../lib/env.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logPageBrainCall, runPageBrain } from '../lib/apply-page-brain.ts';
import { parsePageBrainBody } from '../lib/page-brain.ts';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readInput(path?: string): Promise<unknown> {
  if (path) return JSON.parse(await readFile(resolve(path), 'utf8'));
  if (process.stdin.isTTY) throw new Error('Provide --input <file.json> or pipe JSON on stdin');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) throw new Error('Empty stdin; expected JSON input');
  return JSON.parse(text);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.error('Usage: apply:page-brain --mode <next-action|knock-out|field-map|outcome> [--input file.json]');
  process.exit(0);
}

const parsed = parsePageBrainBody(await readInput(flag('input')), flag('mode'));
if (!parsed.ok) {
  console.error(JSON.stringify({ error: parsed.error }));
  process.exit(2);
}

const started = Date.now();
try {
  const result = await runPageBrain(parsed.input);
  const latencyMs = Date.now() - started;
  await logPageBrainCall({ source: 'cli', input: parsed.input, result, latencyMs });
  process.stdout.write(`${JSON.stringify({ ...result, latencyMs })}\n`);
} catch (error) {
  const latencyMs = Date.now() - started;
  const message = error instanceof Error ? error.message : String(error);
  await logPageBrainCall({ source: 'cli', input: parsed.input, error: message, latencyMs });
  console.error(JSON.stringify({ error: message, mode: parsed.input.mode, latencyMs }));
  process.exit(1);
}
