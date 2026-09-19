import { EVIDENCE_RULE, askJev, costOf } from './model';
import { loadProfile } from '../profile';

export interface TriageInput {
  title: string;
  company: string;
  location?: string | null;
  ats?: string | null;
}

export interface TriageOutput {
  worthProbability: number;
  inputTokens: number;
  costUsd: number;
}

/** Stage 3 still uses these to label the role from the full description. */
export const ROLE_CRITERIA = {
  fde: 'Forward deployed engineer, customer-embedded engineer, implementation or delivery engineer, professional services engineer',
  solutions: 'Solutions engineer, sales engineer, solutions architect, technical account or customer-facing technical role',
  aiProduct: 'Product management for AI, machine learning, data, or developer-facing platform products',
  product: 'Product management that is not AI, data, or developer focused',
  engineering: 'Software engineering with no customer-facing component',
  other: 'Anything else: marketing, sales, finance, HR, operations, support, design, hardware, or unrelated fields',
} as const;

/** The targets.md sections a title can be judged against. */
const TITLE_SECTIONS = ['Roles I want', 'What makes a role a weak match'];

/**
 * A title says nothing about pay, location policy or team size, so sending the
 * whole targets file only made triage expensive: ~1,370 tokens a call to judge a
 * ~30-token title. These two sections carry what a title can be judged on.
 * Measured on 600 postings, this plus dropping the unused role and seniority
 * questions cut tokens 41% and agreed with the full-profile call on 96.5%,
 * every disagreement within 0.1 of the threshold. Falls back to the whole
 * file if the headings are ever renamed.
 */
export function titleTargets(targets: string): string | Record<string, string> {
  const parts = targets.split(/^## /m);
  const picked = Object.fromEntries(
    TITLE_SECTIONS.map((heading) => {
      const part = parts.find((p) => p.startsWith(heading));
      return [heading, part ? part.slice(part.indexOf('\n') + 1).trim() : ''];
    }),
  );
  return Object.values(picked).every(Boolean) ? picked : targets;
}

/**
 * Stage 1. Runs on title, company and location only, which is all the upstream
 * feed carries. Deliberately tuned for recall: a low `worthProbability` bar here
 * just means we pay to fetch a description, and stage 3 does the real filtering.
 */
export async function triage(job: TriageInput): Promise<TriageOutput> {
  const profile = loadProfile();

  const result = await askJev({
    state: {
      candidate: profile.summary,
      whatTheCandidateWants: titleTargets(profile.targets),
      posting: {
        title: job.title,
        company: job.company,
        location: job.location ?? 'unspecified',
      },
    },
    questions: {
      worthReading: {
        type: 'boolean',
        instructions: `Should we spend a request fetching the full description of \`posting\` for this candidate? Say true whenever the title plausibly matches what the candidate wants, even if you are unsure. Say false only when the title clearly rules it out. ${EVIDENCE_RULE}`,
        criteria: {
          true: 'the title is plausibly one of the roles the candidate wants, at a plausible level',
          false: 'the title is clearly a different profession, or clearly far too junior',
        },
      },
    },
  });

  return {
    worthProbability: result.answers.worthReading.probability,
    inputTokens: result.usage.inputTokens ?? 0,
    costUsd: costOf(result.usage),
  };
}
