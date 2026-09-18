import { Card } from '@/components/ui/card';

export interface Stat {
  label: string;
  value: string;
  hint?: string;
}

/** A KPI row: a handful of headline numbers, each a stat tile, never a grouped bar. */
export function StatTiles({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((s) => (
        <Card key={s.label} className="gap-1 p-4">
          <div className="text-xs font-medium text-muted-foreground">{s.label}</div>
          {/* Proportional figures: a standalone value, not a column. */}
          <div className="text-2xl leading-tight font-semibold">{s.value}</div>
          {s.hint ? <div className="text-xs text-muted-foreground">{s.hint}</div> : null}
        </Card>
      ))}
    </div>
  );
}
