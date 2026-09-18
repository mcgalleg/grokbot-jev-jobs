'use client';

import { useState, useTransition } from 'react';
import { AlertTriangle, Check, ExternalLink, Minus, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { ScoreMeter } from '@/components/score-meter';
import { setVerdict } from '@/app/actions';
import type { Verdict } from '@/lib/verdicts';
import type { ScoredJob } from '@/lib/queries';

const ROLE_LABEL: Record<string, string> = {
  fde: 'Forward deployed',
  solutions: 'Solutions',
  aiProduct: 'AI product',
  product: 'Product',
  engineering: 'Engineering',
  other: 'Other',
  unknown: 'Unclassified',
};

const COMPONENT_LABEL: Record<string, string> = {
  skills: 'Skills match',
  seniority: 'Level match',
  building: 'Hands-on building',
  customerFacing: 'Customer facing',
  aiNative: 'AI native',
  domain: 'Domain fit',
};

const ANSWER_LABEL: Record<string, string> = {
  compBelowFloor: 'stated base below floor',
  blocker: 'hard blocker',
  locationOk: 'location works',
};

/** Weight ceilings from lib/jev/score.ts, so each bar reads against its own max. */
const COMPONENT_MAX: Record<string, number> = {
  skills: 3, seniority: 2, building: 1.5, customerFacing: 1.5, aiNative: 1, domain: 1,
};

function Breakdown({ job }: { job: ScoredJob }) {
  const entries = Object.entries(job.components);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {entries.map(([key, value]) => {
          const max = COMPONENT_MAX[key] ?? 1;
          return (
            <div key={key} className="flex items-center gap-3 text-sm">
              <span className="w-36 shrink-0 text-muted-foreground">
                {COMPONENT_LABEL[key] ?? key}
              </span>
              <div
                className="h-1.5 flex-1 overflow-hidden rounded-r-[4px]"
                style={{ backgroundColor: 'var(--meter-track)' }}
              >
                <div
                  className="h-full rounded-r-[4px]"
                  style={{
                    width: `${Math.min(100, (value / max) * 100)}%`,
                    backgroundColor: 'var(--meter-fill)',
                  }}
                />
              </div>
              <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                {value.toFixed(2)} / {max}
              </span>
            </div>
          );
        })}
      </div>

      <div className="rounded-md border p-3">
        <div className="mb-2 text-xs font-medium text-muted-foreground">Raw answers from jev</div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {Object.entries(job.answers).map(([key, a]) => (
            <div key={key} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{ANSWER_LABEL[key] ?? key}</dt>
              <dd className="tabular-nums">
                {a.choice ?? (a.score !== undefined ? a.score.toFixed(2) : a.probability?.toFixed(2))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function VerdictButtons({ job }: { job: ScoredJob }) {
  const [pending, start] = useTransition();
  const [local, setLocal] = useState(job.verdict);

  const click = (v: Verdict) => {
    const next = local === v ? null : v;
    setLocal(next);
    start(() => {
      void setVerdict(job.url, next);
    });
  };

  const options: { v: Verdict; icon: typeof ThumbsUp; label: string }[] = [
    { v: 'good', icon: ThumbsUp, label: 'Good match' },
    { v: 'bad', icon: ThumbsDown, label: 'Bad match' },
    { v: 'applied', icon: Check, label: 'Applied' },
    { v: 'ignored', icon: Minus, label: 'Ignore' },
  ];

  return (
    <div className="flex items-center gap-1">
      {options.map(({ v, icon: Icon, label }) => (
        <Button
          key={v}
          size="icon"
          variant={local === v ? 'default' : 'ghost'}
          disabled={pending}
          onClick={() => click(v)}
          aria-label={label}
          title={label}
          className="size-8"
        >
          <Icon className="size-4" />
        </Button>
      ))}
    </div>
  );
}

export function JobList({ jobs }: { jobs: ScoredJob[] }) {
  if (!jobs.length) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        Nothing here yet. Run <code className="font-mono">pnpm pipeline</code> locally to score
        postings, then <code className="font-mono">pnpm sync</code> to publish them here.
      </Card>
    );
  }

  return (
    <div className="divide-y rounded-lg border">
      {jobs.map((job) => (
        <div key={job.url} className="flex items-center gap-4 px-4 py-3">
          <ScoreMeter value={job.fitScore} muted={job.verdict === 'bad' || job.verdict === 'ignored'} />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{job.title}</span>
              {job.blockerP > 0.5 ? (
                // Status never rides on color alone: icon plus a written label.
                <Badge variant="destructive" className="shrink-0 gap-1">
                  <AlertTriangle className="size-3" />
                  Blocker
                </Badge>
              ) : null}
              {job.compBelowFloorP > 0.5 ? (
                <Badge variant="destructive" className="shrink-0 gap-1">
                  <AlertTriangle className="size-3" />
                  Under floor
                </Badge>
              ) : null}
            </div>
            <div className="truncate text-sm text-muted-foreground">
              {job.company}
              {job.location ? ` · ${job.location}` : ''}
              {job.salary?.median ? ` · ~$${Math.round(job.salary.median / 1000)}k median` : ''}
            </div>
          </div>

          <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
            {ROLE_LABEL[job.role] ?? job.role}
          </Badge>
          <span
            className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground md:inline"
            title="Mean of jev's per-question confidence"
          >
            conf {job.fitConfidence.toFixed(2)}
          </span>

          <Dialog>
            <DialogTrigger
              render={<Button variant="outline" size="sm" className="shrink-0" />}
            >
              Why
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle className="pr-8">{job.title}</DialogTitle>
                <DialogDescription>
                  {job.company}
                  {job.location ? ` · ${job.location}` : ''} · scored{' '}
                  {job.fitScore.toFixed(2)} / 10 at confidence {job.fitConfidence.toFixed(2)}
                </DialogDescription>
              </DialogHeader>
              <Breakdown job={job} />
            </DialogContent>
          </Dialog>

          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            nativeButton={false}
            render={
              <a href={job.url} target="_blank" rel="noreferrer" aria-label="Open posting" />
            }
          >
            <ExternalLink className="size-4" />
          </Button>

          <VerdictButtons job={job} />
        </div>
      ))}
    </div>
  );
}
