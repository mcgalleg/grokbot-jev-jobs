import { experimental_evaluate as evaluate } from 'ai';
import { EVIDENCE_RULE, JEV_MODEL, costOf, JEV_TIMEOUT_MS } from './model';
import { loadProfile } from '../profile';
import { withRetry } from '../pool';

export interface TriageInput {
  title: string;
  company: string;
  location?: string | null;
  ats?: string | null;
}

export interface TriageOutput {
  role: string;
  roleProbability: number;
  seniority: number;
  worthProbability: number;
  confidence: number;
  inputTokens: number;
  costUsd: number;
}

export const ROLE_CRITERIA = {
  fde: 'Forward deployed engineer, customer-embedded engineer, implementation or delivery engineer, professional services engineer',
  solutions: 'Solutions engineer, sales engineer, solutions architect, technical account or customer-facing technical role',
  aiProduct: 'Product management for AI, machine learning, data, or developer-facing platform products',
  product: 'Product management that is not AI, data, or developer focused',
  engineering: 'Software engineering with no customer-facing component',
  other: 'Anything else: marketing, sales, finance, HR, operations, support, design, hardware, or unrelated fields',
} as const;

/**
 * Stage 1. Runs on title, company and location only, which is all the upstream
 * feed carries. Deliberately tuned for recall: a low `worthProbability` bar here
 * just means we pay to fetch a description, and stage 3 does the real filtering.
 */
export async function triage(job: TriageInput): Promise<TriageOutput> {
  const profile = loadProfile();

  const result = await withRetry(() =>
    evaluate({
      model: JEV_MODEL,
      state: {
        candidate: profile.summary,
        whatTheCandidateWants: profile.targets,
        posting: {
          title: job.title,
          company: job.company,
          location: job.location ?? 'unspecified',
          source: job.ats ?? 'unknown',
        },
      },
      abortSignal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      questions: {
        role: {
          type: 'choice',
          instructions: `Which category best describes this posting, judged from its title? ${EVIDENCE_RULE}`,
          criteria: ROLE_CRITERIA,
        },
        seniority: {
          type: 'score',
          instructions:
            'What level is this role? Judge from the title, ignoring the candidate.',
          criteria: [
            'intern or apprentice',
            'entry level, associate, or junior',
            'mid level, no qualifier in the title',
            'senior',
            'staff, principal, lead, director, or above',
          ],
        },
        worthReading: {
          type: 'boolean',
          instructions:
            'Should we spend a request fetching the full description of this posting for this candidate? Say true whenever the title plausibly matches what the candidate wants, even if you are unsure. Say false only when the title clearly rules it out.',
          criteria: {
            true: 'the title is plausibly one of the roles the candidate wants, at a plausible level',
            false: 'the title is clearly a different profession, or clearly far too junior',
          },
        },
      },
    }),
  );

  const meta = result.providerMetadata?.typesafe as
    | { confidence?: Record<string, number> }
    | undefined;
  const confidences = Object.values(meta?.confidence ?? {});

  return {
    role: result.answers.role.choice,
    roleProbability: result.answers.role.probabilities?.[result.answers.role.choice] ?? 0,
    seniority: result.answers.seniority.score,
    worthProbability: result.answers.worthReading.probability,
    confidence: confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0,
    inputTokens: result.usage.inputTokens ?? 0,
    costUsd: costOf(result.usage),
  };
}
