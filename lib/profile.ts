import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Everything jev is told about the candidate.
 *
 * Read from environment variables first, falling back to `profile/*.md` on disk.
 * Both paths exist for a reason:
 *
 *  - The files are the ergonomic way to edit a profile, and `targets.md` is the
 *    single biggest lever on scoring quality, so it should be easy to change.
 *  - The files are git-ignored (they hold a CV and a salary floor), which means
 *    a GitHub-sourced build never sees them. Env vars are what makes deploy-on-push
 *    work without putting any of it in version control.
 *
 * `pnpm profile:push` copies the files into the Vercel project's env vars.
 */
const dir = resolve(process.cwd(), 'profile');

export const PROFILE_ENV = {
  summary: 'PROFILE_SUMMARY',
  resume: 'PROFILE_RESUME',
  targets: 'PROFILE_TARGETS',
} as const;

export const PROFILE_FILES = {
  summary: 'summary.md',
  resume: 'resume.md',
  targets: 'targets.md',
} as const;

export interface Profile {
  /** ~200 words, for the cheap title pass. */
  summary: string;
  /** The full CV, for deep scoring. */
  resume: string;
  /** What a good role looks like. The biggest lever on scoring quality. */
  targets: string;
}

export type ProfileKey = keyof Profile;

function fromDisk(file: string): string | undefined {
  try {
    return readFileSync(resolve(dir, file), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function part(key: ProfileKey): string {
  const value = process.env[PROFILE_ENV[key]]?.trim() || fromDisk(PROFILE_FILES[key]);
  if (!value) {
    // Worth being loud. The previous version let this surface as a bare ENOENT
    // from deep inside a scoring call, which said nothing about what to do.
    throw new Error(
      `Profile "${key}" is not available. Set ${PROFILE_ENV[key]}, or create ` +
        `profile/${PROFILE_FILES[key]}. See "Your profile" in the README.`,
    );
  }
  return value;
}

let cached: Profile | undefined;

export function loadProfile(): Profile {
  cached ??= { summary: part('summary'), resume: part('resume'), targets: part('targets') };
  return cached;
}

/** Which source each part came from. Used by the health probe. */
export function profileSources(): Record<ProfileKey, 'env' | 'disk' | 'missing'> {
  const keys: ProfileKey[] = ['summary', 'resume', 'targets'];
  return Object.fromEntries(
    keys.map((k) => [
      k,
      process.env[PROFILE_ENV[k]]?.trim()
        ? 'env'
        : fromDisk(PROFILE_FILES[k])
          ? 'disk'
          : 'missing',
    ]),
  ) as Record<ProfileKey, 'env' | 'disk' | 'missing'>;
}

/**
 * The base salary floor, read from the "Base salary floor is $NNN,NNN" line in
 * targets.md so the number lives in one place. Null when the targets state no
 * floor, which turns the salary penalty off rather than guessing one.
 */
export function salaryFloor(): number | null {
  const m = loadProfile().targets.match(/salary floor[^$\n]*\$\s?([\d,]+)/i);
  const n = m ? Number(m[1].replace(/,/g, '')) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
