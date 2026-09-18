import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.cwd(), 'profile');
const read = (name: string) => readFileSync(resolve(dir, name), 'utf8').trim();

/** Everything jev is told about the candidate. Edit the markdown, not this file. */
export interface Profile {
  /** ~200 words, for the cheap title pass. */
  summary: string;
  /** The full CV, for deep scoring. */
  resume: string;
  /** What a good role looks like. The biggest lever on scoring quality. */
  targets: string;
}

let cached: Profile | undefined;

export function loadProfile(): Profile {
  cached ??= {
    summary: read('summary.md'),
    resume: read('resume.md'),
    targets: read('targets.md'),
  };
  return cached;
}
