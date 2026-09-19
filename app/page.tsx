import { StatTiles } from '@/components/stat-tiles';
import { JobList } from '@/components/job-list';
import { ThemeToggle } from '@/components/theme-toggle';
import { getFunnel, getJobs, LIST_LIMIT, STRONG_THRESHOLD, type JobFilter } from '@/lib/queries';

// Counts and apply state change on every button press, so never serve a cached page.
export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const filter: JobFilter = tab === 'all' || tab === 'applied' ? tab : 'open';

  const [funnel, jobs] = await Promise.all([getFunnel(), getJobs(filter, LIST_LIMIT)]);

  const screened = funnel.stages.triage_reject ?? 0;
  // How many rows this tab matches, before the list cap. All three are already
  // in the funnel, so knowing it costs no extra query.
  const matching: number = {
    open: funnel.scored - funnel.handled,
    applied: funnel.applied,
    all: funnel.scored,
  }[filter];
  const stats = [
    { label: 'Scored', value: funnel.scored.toLocaleString(), hint: 'full description read' },
    {
      label: `Strong (${STRONG_THRESHOLD}+)`,
      value: funnel.strong.toLocaleString(),
      hint: 'worth a real look',
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
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Job fit, scored by jev</h1>
          <ThemeToggle />
        </div>
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
            ['open', 'Open'],
            ['applied', 'Applied'],
            ['all', 'All scored'],
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

      {jobs.length < matching ? (
        // Truncation was silent before, which is how ten strong matches sat
        // below a cut nobody could see.
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the {jobs.length} highest-scoring of {matching.toLocaleString()}. The rest score
          below {jobs[jobs.length - 1].fitScore.toFixed(1)}.
        </p>
      ) : null}

      <p className="mt-6 text-xs text-muted-foreground">
        Apply asks Resume Rudy to submit the universal CV and cover; Applied is set only when
        that write-back succeeds. Ignore means not interested and hides the row from Open. If
        the ranking itself looks wrong, the lever is the wording in{' '}
        <code className="font-mono">profile/targets.md</code>, then a rescore.
      </p>
    </main>
  );
}
