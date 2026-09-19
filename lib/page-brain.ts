/**
 * The page brain's contract with Resume Rudy: input shapes, request validation,
 * and the decisions made in code rather than by Jev. No model or database
 * imports, so it is unit-tested directly (lib/page-brain.test.ts).
 *
 * The Jev calls live in lib/apply-page-brain.ts. Rudy reaches them through
 * POST /api/rudy/page-brain; scripts/apply-page-brain.mts is the same thing as
 * a local CLI for debugging.
 */

export const PAGE_BRAIN_MODES = ['next-action', 'knock-out', 'field-map', 'outcome'] as const;
/** Page-brain modes Resume Rudy can call mid-ATS apply. */
export type PageBrainMode = (typeof PAGE_BRAIN_MODES)[number];

export const OUTCOME_CRITERIA = {
  applied: 'Application submitted successfully; confirmation page or thank-you email evidence',
  failed: 'Apply failed with an error, rejection, or hard failure message',
  blocked: 'Stopped by a knock-out, captcha, login wall, or other blocker that needs human help',
  still_working: 'Still mid-flow; form incomplete or next step remaining',
} as const;

export type OutcomeLabel = keyof typeof OUTCOME_CRITERIA;

interface PageContext {
  ats?: string;
  url?: string;
}

export interface NextActionInput extends PageContext {
  pageSummary: string;
  visibleActions: string[];
}

export interface KnockOutInput extends PageContext {
  pageSummary?: string;
  question: string;
  options: string[];
  /** Overrides the profile's facts (PROFILE_FACTS / profile/facts.md) for this call. */
  candidateFacts?: string;
}

export interface FieldMapInput extends PageContext {
  pageSummary?: string;
  /** Profile key we need to fill (e.g. phone, linkedinUrl, yearsExperience). */
  neededKey: string;
  /** Visible field labels on the form. */
  fieldLabels: string[];
}

export interface OutcomeInput extends PageContext {
  pageSummary: string;
  emailEvidence?: string;
}

export type PageBrainInput =
  | ({ mode: 'next-action' } & NextActionInput)
  | ({ mode: 'knock-out' } & KnockOutInput)
  | ({ mode: 'field-map' } & FieldMapInput)
  | ({ mode: 'outcome' } & OutcomeInput);

/** Choice option for a field-map with no matching field; `fieldLabel` comes back null. */
export const NO_FIELD = 'none of these fields';
/** Choice option for a knock-out the candidate facts cannot answer; `truthfulOption` comes back null. */
export const CANNOT_TELL = 'cannot tell from the candidate facts';

/** Trim, drop blanks, and de-duplicate labels, keeping first-seen order. */
export function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
}

/** Turn a list of exact labels into Choice criteria keyed by those labels. */
export function labelsToCriteria(labels: string[]): Record<string, string> {
  return Object.fromEntries(uniqueLabels(labels).map((label) => [label, label]));
}

/**
 * Buttons that abandon or destroy an application. Decided in code, not asked:
 * a word list is exact where it applies, and a wrong click here is not undoable.
 */
const DESTRUCTIVE = /\b(cancel|withdraw|delete|discard|decline|remove|sign ?out|log ?out)\b/i;

export function isDestructive(action: string): boolean {
  return DESTRUCTIVE.test(action);
}

/** `yearsExperience` → "years experience", so the question reads as English. */
export function humanize(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

// Page text is untrusted and every token is paid for, so inputs are capped.
const MAX_TEXT = 8_000;
const MAX_LABELS = 100;
const MAX_LABEL = 300;

export type ParsedPageBrainBody =
  | { ok: true; input: PageBrainInput }
  | { ok: false; error: string };

/**
 * Validate a page-brain request. `mode` comes from the body, or from `modeArg`
 * (the CLI's --mode flag), which wins when both are present.
 */
export function parsePageBrainBody(body: unknown, modeArg?: string): ParsedPageBrainBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const raw = body as Record<string, unknown>;
  const mode = modeArg ?? raw.mode;
  if (typeof mode !== 'string' || !(PAGE_BRAIN_MODES as readonly string[]).includes(mode)) {
    return { ok: false, error: `mode must be one of ${PAGE_BRAIN_MODES.join('|')}` };
  }

  const errors: string[] = [];
  const text = (key: string, required: boolean): string | undefined => {
    const v = raw[key];
    if (v === undefined || v === null || v === '') {
      if (required) errors.push(`${key} is required`);
      return undefined;
    }
    if (typeof v !== 'string') {
      errors.push(`${key} must be a string`);
      return undefined;
    }
    return v.slice(0, MAX_TEXT);
  };
  const labels = (key: string, required: boolean): string[] => {
    const v = raw[key];
    if (v === undefined || v === null) {
      if (required) errors.push(`${key} is required`);
      return [];
    }
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
      errors.push(`${key} must be an array of strings`);
      return [];
    }
    const out = uniqueLabels(v.map((x: string) => x.slice(0, MAX_LABEL))).slice(0, MAX_LABELS);
    if (required && !out.length) errors.push(`${key} must not be empty`);
    return out;
  };

  const context = { ats: text('ats', false), url: text('url', false) };
  let input: PageBrainInput;
  switch (mode as PageBrainMode) {
    case 'next-action':
      input = {
        mode: 'next-action',
        ...context,
        pageSummary: text('pageSummary', true) ?? '',
        visibleActions: labels('visibleActions', true),
      };
      break;
    case 'knock-out':
      input = {
        mode: 'knock-out',
        ...context,
        pageSummary: text('pageSummary', false),
        question: text('question', true) ?? '',
        options: labels('options', false),
        candidateFacts: text('candidateFacts', false),
      };
      break;
    case 'field-map':
      input = {
        mode: 'field-map',
        ...context,
        pageSummary: text('pageSummary', false),
        neededKey: text('neededKey', true) ?? '',
        fieldLabels: labels('fieldLabels', true),
      };
      break;
    case 'outcome': {
      // Older Rudy payloads sent the page text as `evidence`.
      const pageSummary =
        raw.pageSummary === undefined && typeof raw.evidence === 'string'
          ? raw.evidence.slice(0, MAX_TEXT)
          : text('pageSummary', true);
      input = {
        mode: 'outcome',
        ...context,
        pageSummary: pageSummary ?? '',
        emailEvidence: text('emailEvidence', false),
      };
      break;
    }
  }
  return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true, input };
}

function truncate(value: unknown, max = 240): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** What gets logged per call: enough to audit a decision, not the whole page. */
export function summarizeInput(input: PageBrainInput): Record<string, unknown> {
  switch (input.mode) {
    case 'next-action':
      return {
        ats: input.ats,
        url: truncate(input.url, 200),
        pageSummary: truncate(input.pageSummary),
        visibleActions: input.visibleActions,
      };
    case 'knock-out':
      return {
        ats: input.ats,
        url: truncate(input.url, 200),
        question: truncate(input.question),
        options: input.options,
        candidateFactsOverride: input.candidateFacts !== undefined,
      };
    case 'field-map':
      return {
        ats: input.ats,
        url: truncate(input.url, 200),
        neededKey: input.neededKey,
        fieldLabels: input.fieldLabels,
      };
    case 'outcome':
      return {
        ats: input.ats,
        url: truncate(input.url, 200),
        pageSummary: truncate(input.pageSummary),
        emailEvidence: truncate(input.emailEvidence),
      };
  }
}
