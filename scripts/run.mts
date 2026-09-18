/**
 * One CLI for the four pipeline stages.
 *
 * These call the same functions in lib/stages that the cron route calls, so
 * there is exactly one implementation of each stage and no chance of the
 * scheduled run and the hand-run diverging.
 *
 * Usage: pnpm ingest | triage | describe | score | pipeline  [flags]
 */
import '../lib/env.ts';
import { getSql, migrate } from '../lib/db/pg.ts';
import { runIngest } from '../lib/stages/ingest.ts';
import { runTriage } from '../lib/stages/triage.ts';
import { runDescribe } from '../lib/stages/describe.ts';
import { runScore } from '../lib/stages/score.ts';
import { DEFAULT_SCREEN } from '../lib/screen.ts';

const [stage, ...args] = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const num = (n: string, d?: number) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : d;
};
const str = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
};

await migrate();
const sql = getSql();

const limit = num('limit');
const concurrency = num('concurrency');

/** Reset rows to an earlier stage so a changed profile or prompt can be re-run. */
async function redo(from: string[], to: string) {
  const r = await sql.query(
    `UPDATE jobs SET stage = $1 WHERE stage = ANY($2::text[]) RETURNING url`,
    [to, from],
  );
  console.log(`--redo: moved ${r.length} rows back to '${to}'`);
}

switch (stage) {
  case 'ingest': {
    await runIngest({
      maxChunks: num('chunks'),
      since: str('since') ?? null,
      screenConfig: flag('drop-junior-levels')
        ? { ...DEFAULT_SCREEN, dropSkillLevels: ['intern', 'entry'] }
        : DEFAULT_SCREEN,
    });
    break;
  }
  case 'triage': {
    if (flag('redo')) await redo(['triaged', 'triage_reject'], 'new');
    await runTriage({ limit, concurrency, threshold: num('threshold'), ats: str('ats') });
    break;
  }
  case 'describe': {
    await runDescribe({ limit, concurrency });
    break;
  }
  case 'score': {
    if (flag('redo')) await redo(['scored'], 'fetched');
    await runScore({ limit, concurrency });
    break;
  }
  case 'pipeline': {
    const n = limit ?? 500;
    await runIngest({ maxChunks: num('chunks'), since: str('since') ?? null });
    await runTriage({ limit: n, concurrency });
    await runDescribe({ limit: n, concurrency });
    await runScore({ limit: n, concurrency });
    break;
  }
  default:
    console.error(
      `unknown stage: ${stage ?? '(none)'}\n` +
        'expected one of: ingest, triage, describe, score, pipeline',
    );
    process.exit(1);
}
