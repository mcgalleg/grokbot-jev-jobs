import { StatTiles } from '@/components/stat-tiles';
import { JobList } from '@/components/job-list';
import { getFunnel, getJobs, STRONG_THRESHOLD, type JobFilter } from '@/lib/queries';

// Counts and verdicts change on every button press, so never serve a cached page.
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const filter: JobFilter = tab === 'all' || tab === 'labeled' ? tab : 'top';

  const [funnel, jobs] = await Promise.all([getFunnel(), getJobs(filter, 150)]);

  const screened = funnel.stages.triage_reject ?? 0;
  const stats = [
    { label: 'Scored', value: funnel.scored.toLocaleString(), hint: 'full description read' },
    {
      label: `Strong (${STRONG_THRESHOLD}+)`,
      value: funnel.strong.toLocaleString(),
      hint: 'worth a real look',
    },
    {
      // Named for whose job it is. "Awaiting review" read as pipeline backlog
      // sitting beside three pipeline counters, which is exactly what it is not.
      label: 'Labelled by you',
      value: funnel.labeled.toLocaleString(),
      hint: `of ${funnel.scored.toLocaleString()} scored`,
    },
    {
      label: 'Jev spend',
      value: `$${funnel.spendUsd.toFixed(3)}`,
      hint: `${screened.toLocaleString()} rejected at triage`,
    },
  ];

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Job fit, scored by jev</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Postings from the public aggregator feed, screened in code, triaged and scored by
          TypeSafe&nbsp;jev through the Vercel AI Gateway.
          {funnel.lastIngest ? ` Last ingest ${funnel.lastIngest.slice(0, 16).replace('T', ' ')}.` : ''}
          {/* The only place the page says anything about pipeline backlog. */}
          {funnel.pending > 0
            ? ` ${funnel.pending.toLocaleString()} still queued for processing.`
            : ' Nothing queued for processing.'}
        </p>
      </header>

      <div className="mb-6">
        <StatTiles stats={stats} />
      </div>

      <nav className="mb-4 inline-flex items-center gap-1 rounded-lg bg-muted p-1">
        {(
          [
            ['top', 'Needs review'],
            ['all', 'All scored'],
            ['labeled', 'Labelled'],
          ] as const
        ).map(([key, label]) => (
          <a
            key={key}
            href={`/?tab=${key}`}
            aria-current={filter === key ? 'page' : undefined}
            className={
              filter === key
                ? 'rounded-md bg-background px-3 py-1.5 text-sm font-medium shadow-sm'
                : 'rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground'
            }
          >
            {label}
          </a>
        ))}
      </nav>

      <JobList jobs={jobs} />

      <p className="mt-6 text-xs text-muted-foreground">
        Your verdicts are the labelled set. Once a few dozen are in, compare them against the
        ranking to see whether the weights in <code className="font-mono">lib/jev/score.ts</code>{' '}
        and the wording in <code className="font-mono">profile/targets.md</code> need tuning.
      </p>
    </main>
  );
}
