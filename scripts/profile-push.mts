/**
 * Copy profile/*.md into the Vercel project's environment variables.
 *
 * The files are git-ignored, so a GitHub-sourced build never sees them. This is
 * what keeps deploy-on-push working: edit the markdown as usual, run this, and
 * the deployed pipeline picks the new profile up on its next build.
 *
 * Re-run it after editing targets.md — that file is the biggest lever on scoring
 * quality, and a stale copy in Vercel means the nightly run is scoring against
 * the old one.
 *
 * Usage: pnpm profile:push [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROFILE_ENV, PROFILE_FILES, type ProfileKey } from '../lib/profile.ts';

const DRY = process.argv.includes('--dry-run');
const ENVIRONMENTS = ['production', 'preview', 'development'] as const;
const KEYS: ProfileKey[] = ['summary', 'resume', 'targets'];

/** Vercel caps the total size of a deployment's environment at 64KB. */
const TOTAL_LIMIT = 64 * 1024;

const parts = KEYS.map((key) => {
  const file = resolve(process.cwd(), 'profile', PROFILE_FILES[key]);
  const body = readFileSync(file, 'utf8').trim();
  if (!body) throw new Error(`profile/${PROFILE_FILES[key]} is empty`);
  return { key, name: PROFILE_ENV[key], body };
});

const total = parts.reduce((n, p) => n + Buffer.byteLength(p.body), 0);
for (const p of parts) {
  console.log(`${p.name.padEnd(16)} ${Buffer.byteLength(p.body).toLocaleString().padStart(7)} bytes`);
}
console.log(`${'TOTAL'.padEnd(16)} ${total.toLocaleString().padStart(7)} bytes of a ${TOTAL_LIMIT.toLocaleString()} byte budget`);
if (total > TOTAL_LIMIT * 0.8) {
  console.warn('WARNING: close to the 64KB environment limit. Move the profile into Postgres instead.');
}

if (DRY) {
  console.log('\n--dry-run, nothing sent');
  process.exit(0);
}

const run = (args: string[], input?: string) => {
  const r = spawnSync('vercel', args, { input, encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

console.log();
for (const part of parts) {
  for (const environment of ENVIRONMENTS) {
    // `env add` refuses to overwrite, so remove first. A missing variable makes
    // the remove a no-op, which is exactly what a first run needs.
    run(['env', 'rm', part.name, environment, '--yes']);
    const { code, out } = run(['env', 'add', part.name, environment], part.body);
    if (code !== 0) {
      console.error(`FAILED ${part.name} (${environment}):\n${out.slice(0, 400)}`);
      process.exit(1);
    }
    console.log(`  set ${part.name} (${environment})`);
  }
}

console.log('\nDone. Redeploy for the running pipeline to pick these up:');
console.log('  vercel deploy --prod   (or push to the connected branch)');
