/**
 * Backfill for the pre-sales filter in lib/stages/score.ts: ask Jev which open-queue postings are pre-sales roles, and mark them
 * ignored. Ignore is the dashboard's own "not interested" label, so any row this
 * removes can be restored from the UI.
 *
 * Usage:
 *   pnpm purge:presales                 classify, write output/presales.jsonl, change nothing
 *   pnpm purge:presales --apply         ignore rows whose top choice is pre-sales, from that file
 *   pnpm purge:presales --threshold 0.7 use a pre-sales probability cut instead of the top choice
 *
 * --apply reuses the saved judgments rather than re-asking, so what you reviewed
 * is exactly what gets purged.
 */
import '../lib/env.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { getSql } from '../lib/db/pg.ts';
import { htmlToText, looksLikeHtml } from '../lib/ats.ts';
import { EVIDENCE_RULE, askJev, costOf } from '../lib/jev/model.ts';
import { MOTION_CRITERIA } from '../lib/jev/score.ts';
import { mapPool } from '../lib/pool.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const ti = args.indexOf('--threshold');
/** Default rule: purge when pre-sales is Jev's top choice. --threshold switches to a probability cut. */
const threshold = ti >= 0 ? Number(args[ti + 1]) : null;
const OUT = 'output/presales.jsonl';
/** The pre-sales signal lives in the first half of a posting; this keeps cost flat. */
const MAX_CHARS = 6_000;

interface Row {
  url: string;
  title: string;
  company: string;
  description: string | null;
}
interface Judged {
  url: string;
  title: string;
  company: string;
  motion: string;
  preSalesP: number;
  probabilities: Record<string, number>;
}

const sql = getSql();

async function classify(): Promise<Judged[]> {
  const rows = (await sql`
    SELECT j.url, j.title, j.company, j.description FROM jobs j
    LEFT JOIN labels l ON l.url = j.url
    LEFT JOIN applies a ON a.url = j.url
    WHERE j.stage = 'scored'
      AND (l.url IS NULL OR l.verdict <> 'ignored')
      AND (a.url IS NULL OR a.status <> 'applied')`) as Row[];
  console.log(`classifying ${rows.length} open postings`);

  let cost = 0;
  let errors = 0;
  const judged = await mapPool(
    rows,
    16,
    async (row): Promise<Judged | null> => {
      try {
        const r = await askJev({
          state: {
            posting: {
              title: row.title.trim(),
              company: row.company,
              description: (looksLikeHtml(row.description ?? '') ? htmlToText(row.description ?? '') : row.description ?? '').slice(0, MAX_CHARS),
            },
          },
          questions: {
            motion: {
              type: 'choice',
              instructions: `Where in the customer lifecycle does this role mainly do its work, judged from \`posting.title\` and \`posting.description\`? ${EVIDENCE_RULE}`,
              criteria: MOTION_CRITERIA,
            },
          },
        });
        cost += costOf(r.usage);
        const m = r.answers.motion;
        return {
          url: row.url,
          title: row.title.trim(),
          company: row.company,
          motion: m.choice,
          preSalesP: m.probabilities?.preSales ?? (m.choice === 'preSales' ? 1 : 0),
          probabilities: m.probabilities ?? {},
        };
      } catch (error) {
        errors++;
        console.error(`  ${row.url}: ${(error as Error).message.slice(0, 120)}`);
        return null;
      }
    },
    (done, total) => {
      if (done % 250 === 0 || done === total) console.log(`  ${done}/${total}`);
    },
  );

  const ok = judged.filter((j): j is Judged => j !== null);
  mkdirSync('output', { recursive: true });
  writeFileSync(OUT, ok.map((j) => JSON.stringify(j)).join('\n') + '\n');
  console.log(`wrote ${OUT}: ${ok.length} judged, ${errors} errors, $${cost.toFixed(4)}`);
  return ok;
}

const judged: Judged[] =
  apply && existsSync(OUT)
    ? readFileSync(OUT, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : await classify();

const byMotion: Record<string, number> = {};
for (const j of judged) byMotion[j.motion] = (byMotion[j.motion] ?? 0) + 1;
console.log('motion (argmax):', byMotion);

const isPurged = (j: Judged) => (threshold === null ? j.motion === 'preSales' : j.preSalesP >= threshold);
const purge = judged.filter(isPurged).sort((a, b) => a.preSalesP - b.preSalesP);
const bands = [0.5, 0.6, 0.7, 0.8, 0.9].map((t) => `≥${t}: ${judged.filter((j) => j.preSalesP >= t).length}`);
console.log(`preSales probability bands — ${bands.join(', ')}`);

if (!apply) {
  console.log(`\nwould ignore ${purge.length} by ${threshold === null ? 'top choice' : `threshold ${threshold}`}. Borderline (lowest kept-for-purge):`);
  for (const j of purge.slice(0, 25)) console.log(`  ${j.preSalesP.toFixed(2)}  ${j.title} — ${j.company}`);
  console.log('\nJust below the threshold (would stay):');
  const below = judged.filter((j) => !isPurged(j)).sort((a, b) => b.preSalesP - a.preSalesP);
  for (const j of below.slice(0, 25)) console.log(`  ${j.preSalesP.toFixed(2)}  ${j.title} — ${j.company} [${j.motion}]`);
  console.log('\ndry run: nothing changed. Re-run with --apply to ignore these.');
} else {
  const urls = purge.map((j) => j.url);
  const r = await sql`
    INSERT INTO labels (url, verdict)
    SELECT u, 'ignored' FROM unnest(${urls}::text[]) AS u
    ON CONFLICT (url) DO UPDATE SET verdict = 'ignored'
    RETURNING url`;
  console.log(`ignored ${r.length} pre-sales postings (${threshold === null ? 'top choice' : `threshold ${threshold}`})`);
}
