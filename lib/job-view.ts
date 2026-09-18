import type { ApplyStatus } from './apply';
import type { SalaryEstimate } from './format';

export type JobAnswer = {
  type: string;
  choice?: string;
  score?: number;
  probability?: number;
};

/**
 * Fields the list actually renders. Score breakdown stays on the server
 * until Why is opened — serializing it on every row made `/` ~3 MB.
 */
export interface JobListItem {
  url: string;
  title: string;
  company: string;
  location: string | null;
  fitScore: number;
  fitConfidence: number;
  blockerP: number;
  compBelowFloorP: number;
  role: string;
  salary: SalaryEstimate | null;
  /** Pre-rendered so the client never recomputes a relative date. See lib/format.ts. */
  posted: { label: string; title: string } | null;
  ignored: boolean;
  applyStatus: ApplyStatus | null;
  applyDetail: string | null;
}

export interface JobBreakdown {
  components: Record<string, number>;
  answers: Record<string, JobAnswer>;
}
