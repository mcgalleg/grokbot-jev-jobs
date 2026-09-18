'use client';

import { useState, useTransition } from 'react';
import { AlertTriangle, Check, Loader2, Minus, RotateCw, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { ScoreMeter } from '@/components/score-meter';
import { requestApply, setIgnored } from '@/app/actions';
import { canStartApply, type ApplyStatus } from '@/lib/apply';
import { formatSalary } from '@/lib/format';
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

const APPLY_LABEL: Record<ApplyStatus, string> = {
  applying: 'Applying',
  applied: 'Applied',
  failed: 'Failed',
  blocked: 'Blocked',
  skipped: 'Skipped',
};

/**
 * Column widths, shared by the header and every row.
 *
 * The list is a flex layout rather than a <table> because each row carries
 * controls and a dialog, but the columns still have to line up under their
 * labels, so the widths live in one place. The trailing width is the action
 * group measured: Why (w-16) + gap-2 + optional status badge + Apply + Ignore.
 */
const COL = {
  fit: 'w-[126px] shrink-0',
  role: 'hidden w-28 shrink-0 sm:block',
  salary: 'hidden w-16 shrink-0 text-right sm:block',
  posted: 'hidden w-20 shrink-0 text-right md:block',
  actions: 'w-[268px] shrink-0',
} as const;

function Header() {
  return (
    <div className="flex items-center gap-4 border-b px-4 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      <span className={COL.fit}>Fit</span>
      <span className="min-w-0 flex-1">Role</span>
      <span className={COL.role}>Type</span>
      <span className={COL.salary} title="Market estimate from the aggregator, not stated pay">
        Salary
      </span>
      <span className={COL.posted}>Posted</span>
      <span className={`${COL.actions} text-right`}>Status</span>
    </div>
  );
}

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

function ApplyStatusBadge({
  status,
  detail,
}: {
  status: ApplyStatus | null;
  detail: string | null;
}) {
  if (!status) return null;
  const title = detail ? `${APPLY_LABEL[status]}: ${detail}` : APPLY_LABEL[status];
  if (status === 'applying') {
    return (
      <Badge variant="secondary" className="shrink-0 gap-1" title={title}>
        <Loader2 className="size-3 animate-spin" />
        Applying
      </Badge>
    );
  }
  if (status === 'applied') {
    return (
      <Badge variant="secondary" className="shrink-0 gap-1" title={title}>
        <Check className="size-3" />
        Applied
      </Badge>
    );
  }
  return (
    <Badge
      variant={status === 'skipped' ? 'secondary' : 'destructive'}
      className="shrink-0"
      title={title}
    >
      {APPLY_LABEL[status]}
    </Badge>
  );
}

function ApplyControls({
  job,
  applyStatus,
  applyDetail,
  setApplyStatus,
  setApplyDetail,
}: {
  job: ScoredJob;
  applyStatus: ApplyStatus | null;
  applyDetail: string | null;
  setApplyStatus: (status: ApplyStatus | null) => void;
  setApplyDetail: (detail: string | null) => void;
}) {
  const [pending, start] = useTransition();
  const [ignored, setLocalIgnored] = useState(job.ignored);

  const applying = applyStatus === 'applying';
  const applied = applyStatus === 'applied';
  const retryable = canStartApply(applyStatus);

  const onApply = () => {
    if (!retryable) return;
    setApplyStatus('applying');
    start(async () => {
      const result = await requestApply(job.url);
      if (result.ok) {
        setApplyStatus('applying');
        setApplyDetail(null);
        return;
      }
      if (result.code === 'already-applying') {
        setApplyStatus('applying');
        return;
      }
      if (result.code === 'already-applied') {
        setApplyStatus('applied');
        return;
      }
      setApplyStatus(result.status ?? 'failed');
      setApplyDetail(result.message);
    });
  };

  const onIgnore = () => {
    const next = !ignored;
    setLocalIgnored(next);
    start(() => {
      void setIgnored(job.url, next);
    });
  };

  const statusTitle = applyDetail
    ? `${APPLY_LABEL[applyStatus ?? 'failed']}: ${applyDetail}`
    : applyStatus
      ? APPLY_LABEL[applyStatus]
      : 'Ask Resume Rudy to submit the universal CV and cover';

  return (
    <div className="flex items-center justify-end gap-1">
      {applied ? (
        <Button size="sm" variant="default" disabled className="w-24" title="Rudy reported this as submitted">
          <Check className="size-3.5" />
          Applied
        </Button>
      ) : applying ? (
        <Button
          size="sm"
          variant="default"
          disabled
          aria-busy="true"
          className="w-24"
          title="Waiting for Resume Rudy to write back"
        >
          <Loader2 className="size-3.5 animate-spin" />
          Applying
        </Button>
      ) : (
        <Button
          size="sm"
          variant={applyStatus ? 'outline' : 'default'}
          disabled={pending}
          onClick={onApply}
          title={statusTitle}
          className="w-24"
        >
          {applyStatus ? <RotateCw className="size-3.5" /> : <Send className="size-3.5" />}
          {applyStatus ? 'Retry' : 'Apply'}
        </Button>
      )}

      <Button
        size="sm"
        variant={ignored ? 'default' : 'ghost'}
        disabled={pending}
        onClick={onIgnore}
        aria-pressed={ignored}
        title={ignored ? 'Ignored — press again to show on Open' : 'Not interested'}
        className="w-24"
      >
        <Minus className="size-3.5" />
        Ignore
      </Button>
    </div>
  );
}

export function JobList({ jobs }: { jobs: ScoredJob[] }) {
  if (!jobs.length) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        Nothing in this tab. The cron scores new postings daily at 15:00 UTC;{' '}
        <code className="font-mono">pnpm pipeline</code> runs the same thing by hand.
      </Card>
    );
  }

  return (
    <div className="divide-y rounded-lg border">
      <Header />
      {jobs.map((job) => (
        <JobRow key={job.url} job={job} />
      ))}
    </div>
  );
}

function JobRow({ job }: { job: ScoredJob }) {
  const [applyStatus, setApplyStatus] = useState(job.applyStatus);
  const [applyDetail, setApplyDetail] = useState(job.applyDetail);
  const salary = formatSalary(job.salary);

  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className={COL.fit}>
        <ScoreMeter value={job.fitScore} muted={job.ignored} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {/* The title is the link to the posting. */}
          <a
            href={job.url}
            target="_blank"
            rel="noreferrer"
            title={job.title}
            className="truncate font-medium underline-offset-4 hover:underline"
          >
            {job.title}
          </a>
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
          <ApplyStatusBadge status={applyStatus} detail={applyDetail} />
        </div>
        <div className="truncate text-sm text-muted-foreground">
          {job.company}
          {job.location ? ` · ${job.location}` : ''}
          {/* Below sm the salary and posted columns are hidden, so carry both here. */}
          <span className="sm:hidden">
            {salary ? ` · ${salary.label}` : ''}
            {job.posted ? ` · ${job.posted.label}` : ''}
          </span>
        </div>
      </div>

      <div className={COL.role}>
        <Badge variant="secondary" className="max-w-full truncate">
          {ROLE_LABEL[job.role] ?? job.role}
        </Badge>
      </div>

      <span
        className={`${COL.salary} text-sm tabular-nums ${salary ? 'text-foreground' : 'text-muted-foreground'}`}
        title={salary?.title ?? 'The aggregator has no market estimate for this posting'}
      >
        {salary?.label ?? '—'}
      </span>

      <span
        className={`${COL.posted} text-sm whitespace-nowrap text-muted-foreground`}
        title={job.posted?.title ?? 'No date in the feed for this posting'}
      >
        {job.posted?.label ?? '—'}
      </span>

      <div className={`${COL.actions} flex items-center justify-end gap-2`}>
        <Dialog>
          <DialogTrigger
            render={<Button variant="outline" size="sm" className="w-16 shrink-0" />}
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

        <ApplyControls
          job={job}
          applyStatus={applyStatus}
          applyDetail={applyDetail}
          setApplyStatus={setApplyStatus}
          setApplyDetail={setApplyDetail}
        />
      </div>
    </div>
  );
}
