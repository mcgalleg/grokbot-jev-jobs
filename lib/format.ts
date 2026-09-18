/**
 * Display helpers for the two feed-supplied columns, salary and posted date.
 *
 * Kept out of the components because the posted label depends on the clock, and
 * a client component that recomputes "6d ago" during hydration can disagree with
 * what the server rendered. `getJobs` formats it once, server-side, and the
 * component just prints the string.
 */

export interface SalaryEstimate {
  p25?: number;
  median?: number;
  p75?: number;
  n?: number;
}

const usd = (n: number) => `$${Math.round(n / 1000)}k`;

/**
 * The aggregator's market estimate for the title and location, NOT the pay the
 * posting states. Two thirds of rows have no estimate at all, and where it does
 * exist it is a lookup against comparable roles. The `~` and the tooltip are
 * what keep it from being read as an offer — jev judges the real number from the
 * description, and that verdict is the "Under floor" badge, not this column.
 */
export function formatSalary(
  salary: SalaryEstimate | null | undefined,
): { label: string; title: string } | null {
  if (!salary?.median) return null;
  const range = [salary.p25, salary.p75].every((v) => typeof v === 'number')
    ? `${usd(salary.p25!)}–${usd(salary.p75!)}`
    : null;
  return {
    label: `~${usd(salary.median)}`,
    title:
      `Market estimate for this title and location, not the posting's stated pay. ` +
      `Median ${usd(salary.median)}` +
      (range ? `, middle half ${range}` : '') +
      (salary.n ? `, from ${salary.n} comparable postings.` : '.'),
  };
}

const DAY = 86_400_000;

const utcMidnight = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/**
 * `updated_at` is the ATS's own timestamp and is the honest answer when present;
 * it is missing on about a third of rows, where the best we know is when the
 * aggregator first saw the posting. That is an upper bound on its age, not a
 * posting date, so the tooltip says which one is being shown.
 */
export function formatPosted(
  postedAt: string | null | undefined,
  firstSeen: string | null | undefined,
  now: number = Date.now(),
): { label: string; title: string } | null {
  const exact = postedAt ?? firstSeen;
  if (!exact) return null;
  const t = Date.parse(exact);
  if (Number.isNaN(t)) return null;

  const date = new Date(t);
  // Calendar days apart, not elapsed hours: an 11pm posting read at 1am is
  // "1d ago", and "today" never contradicts the exact date in the tooltip.
  const days = Math.round((utcMidnight(now) - utcMidnight(t)) / DAY);
  const thisYear = date.getUTCFullYear() === new Date(now).getUTCFullYear();
  // Recent postings get a relative label, this year's get a day, and anything
  // older gets only its month — by then the exact day tells you nothing that
  // "this is stale" does not, and it keeps the column one line wide.
  const label =
    days < 1
      ? 'today'
      : days < 30
        ? `${days}d ago`
        : date.toLocaleDateString('en-US', {
            month: 'short',
            ...(thisYear ? { day: 'numeric' } : { year: 'numeric' }),
            timeZone: 'UTC',
          });

  const full = date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return {
    label,
    title: postedAt
      ? `Last updated on the job board ${full}.`
      : `First seen in the feed ${full}. The feed carries no posting date for this one, so it may be older.`,
  };
}
