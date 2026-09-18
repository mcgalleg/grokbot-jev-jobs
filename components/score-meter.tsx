/**
 * A single ratio against a limit, so: a meter, not a one-bar bar chart.
 * Square at the baseline, 4px rounded at the data end, track one lighter
 * step of the same hue.
 */
export function ScoreMeter({
  value,
  max = 10,
  muted = false,
}: {
  value: number;
  max?: number;
  muted?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2.5">
      <span className="w-9 shrink-0 text-right text-sm font-medium tabular-nums">
        {value.toFixed(1)}
      </span>
      <div
        className="h-1.5 w-20 shrink-0 overflow-hidden rounded-l-none rounded-r-[4px]"
        style={{ backgroundColor: 'var(--meter-track)' }}
        role="img"
        aria-label={`Fit score ${value.toFixed(1)} out of ${max}`}
      >
        <div
          className="h-full rounded-l-none rounded-r-[4px]"
          style={{
            width: `${pct}%`,
            backgroundColor: muted ? 'var(--meter-muted)' : 'var(--meter-fill)',
          }}
        />
      </div>
    </div>
  );
}
