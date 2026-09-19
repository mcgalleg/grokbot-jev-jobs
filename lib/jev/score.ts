import { experimental_evaluate as evaluate } from 'ai';
import { EVIDENCE_RULE, JEV_MODEL, costOf, JEV_TIMEOUT_MS } from './model';
import { ROLE_CRITERIA } from './triage';
import { loadProfile } from '../profile';
import { withRetry } from '../pool';

export interface ScoreInput {
  title: string;
  company: string;
  location?: string | null;
  description: string;
}

export interface ScoreOutput {
  fitScore: number;
  confidence: number;
  blockerProbability: number;
  compBelowFloorProbability: number;
  /** Jev's top choice for where in the customer lifecycle the role works. */
  motion: keyof typeof MOTION_CRITERIA;
  preSalesProbability: number;
  answers: Record<string, unknown>;
  components: Record<string, number>;
  inputTokens: number;
  costUsd: number;
}

/**
 * Composite weights. TypeSafe recommends asking several atomic questions and
 * combining them in code rather than asking one vague "is this a good fit",
 * because the weights stay inspectable and tunable without re-prompting.
 * These sum to 10 before the blocker and location penalties are applied.
 */
export const WEIGHTS = {
  skills: 3,
  seniority: 2,
  building: 1.5,
  customerFacing: 1.5,
  aiNative: 1,
  domain: 1,
} as const;

/**
 * Where in the customer lifecycle a role works. The candidate does not want
 * pre-sales, and "solutions engineer" or "solutions architect" titles are split
 * between pre-sales and post-sales, so the title alone cannot decide it.
 *
 * The `excludes` clause matters: without it, growth and enterprise product
 * managers read as pre-sales because they also help win customers. Measured on
 * the 5,381-row open queue, it took PM titles in the pre-sales set from 20 to 1.
 */
export const MOTION_CRITERIA = {
  preSales: {
    definition:
      'Pre-sales: a role on or beside the sales team that works directly with specific prospects to win deals before the contract is signed.',
    examples:
      'product demos, proofs of concept, technical discovery calls with prospects, RFP and security questionnaire responses, partnering with account executives, carrying or supporting a quota or pipeline target. Typical titles: sales engineer, pre-sales consultant, pre-sales solutions engineer or solutions architect, field CTO.',
    excludes:
      'Product managers, growth, marketing, and developer relations roles are not pre-sales even when they drive acquisition or revenue, because they work through the product or audience rather than on individual deals.',
  },
  postSales:
    'Post-sales: the role mainly works with customers who have already bought, such as deployment, implementation, onboarding, forward deployed or embedded engineering, professional services, or customer success.',
  mixed:
    'A customer-facing technical role that clearly and substantially spans both winning individual deals and delivering for existing customers, with neither dominating.',
  notCustomerFacing:
    'Not organised around individual customer accounts: product management (including growth and acquisition product management), software engineering, developer relations, marketing, and other internal roles.',
};

/** How long a description we send. Keeps cost predictable on verbose postings. */
export const MAX_DESCRIPTION_CHARS = 12_000;

export async function scoreJob(job: ScoreInput): Promise<ScoreOutput> {
  const profile = loadProfile();

  const result = await withRetry(() =>
    evaluate({
      model: JEV_MODEL,
      state: {
        candidateResume: profile.resume,
        whatTheCandidateWants: profile.targets,
        posting: {
          title: job.title,
          company: job.company,
          location: job.location ?? 'unspecified',
          description: job.description.slice(0, MAX_DESCRIPTION_CHARS),
        },
      },
      abortSignal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      questions: {
        role: {
          type: 'choice',
          instructions: `Which category best describes this role, judged from the full description? ${EVIDENCE_RULE}`,
          criteria: ROLE_CRITERIA,
        },
        motion: {
          type: 'choice',
          instructions: `Where in the customer lifecycle does this role mainly do its work, judged from \`posting.title\` and \`posting.description\`? ${EVIDENCE_RULE}`,
          criteria: MOTION_CRITERIA,
        },
        skills: {
          type: 'score',
          instructions:
            "How well does the candidate's experience cover the requirements this posting actually states?",
          criteria: [
            'few of the stated requirements are met',
            'about half the stated requirements are met',
            'most stated requirements are met',
            'every core requirement is met, with relevant depth beyond them',
          ],
        },
        seniority: {
          type: 'score',
          instructions:
            'Compare the level of this role to the candidate, who has held principal product management and senior consulting roles.',
          criteria: [
            'far below the candidate, an entry or junior role',
            'somewhat below the candidate',
            'a good level match',
            'above anything the candidate has held, such as VP or C-level',
          ],
        },
        building: {
          type: 'boolean',
          instructions:
            'Does this role expect hands-on building, writing code, or prototyping as part of the job?',
        },
        customerFacing: {
          type: 'boolean',
          instructions:
            'Does this role involve direct contact with customers or users, such as discovery, deployment, or embedded delivery?',
        },
        aiNative: {
          type: 'boolean',
          instructions:
            'Is the product or team actively building with AI, machine learning, or large language models?',
        },
        domain: {
          type: 'boolean',
          instructions:
            'Is the product in cybersecurity, governance risk and compliance, data infrastructure, or developer tooling?',
        },
        locationOk: {
          type: 'boolean',
          instructions:
            'Can this role be done remotely from Colorado, or is it based in the Denver or Lakewood metro area?',
          criteria: {
            true: 'fully remote, remote within the United States, or located in the Denver metro area',
            false: 'requires on-site or hybrid presence somewhere other than the Denver metro area',
          },
        },
        blocker: {
          type: 'boolean',
          instructions:
            'Does this posting state a hard requirement the candidate cannot meet, such as an active security clearance, a specific advanced degree, relocation, or work authorization in another country?',
        },
        compBelowFloor: {
          type: 'boolean',
          instructions:
            "Does this posting state a base salary whose top of range falls below the candidate's stated floor? Judge only figures written in the posting itself. Most postings state no salary, and that is normal.",
          criteria: {
            true: 'the posting states a base salary range whose maximum is below the floor in the candidate targets',
            false: 'the posting states no salary, states only equity or total compensation, or states a base range reaching the floor or above',
          },
        },
      },
    }),
  );

  const a = result.answers;
  const norm = (score: number, rungs: number) => score / (rungs - 1);
  // Seniority peaks at the "good level match" rung and falls off either side.
  const seniorityFit = Math.max(0, 1 - Math.abs(a.seniority.score - 2) / 2);

  const components = {
    skills: norm(a.skills.score, 4) * WEIGHTS.skills,
    seniority: seniorityFit * WEIGHTS.seniority,
    building: a.building.probability * WEIGHTS.building,
    customerFacing: a.customerFacing.probability * WEIGHTS.customerFacing,
    aiNative: a.aiNative.probability * WEIGHTS.aiNative,
    domain: a.domain.probability * WEIGHTS.domain,
  };

  const raw = Object.values(components).reduce((sum, v) => sum + v, 0);
  // A hard blocker, a bad location, or a stated base below the floor scales the
  // whole score down rather than zeroing it, so a near-miss stays visible in the
  // ranking for review. Pay is only ever penalised on a figure the posting
  // actually states; silence is the common case and costs nothing.
  const penalty =
    (1 - a.blocker.probability * 0.9) *
    (0.25 + 0.75 * a.locationOk.probability) *
    (1 - a.compBelowFloor.probability * 0.8);

  const meta = result.providerMetadata?.typesafe as
    | { confidence?: Record<string, number> }
    | undefined;
  const confidences = Object.values(meta?.confidence ?? {});

  return {
    fitScore: Number((raw * penalty).toFixed(2)),
    confidence: confidences.length
      ? confidences.reduce((x, y) => x + y, 0) / confidences.length
      : 0,
    blockerProbability: a.blocker.probability,
    compBelowFloorProbability: a.compBelowFloor.probability,
    motion: a.motion.choice as keyof typeof MOTION_CRITERIA,
    preSalesProbability: a.motion.probabilities?.preSales ?? (a.motion.choice === 'preSales' ? 1 : 0),
    answers: a as unknown as Record<string, unknown>,
    components,
    inputTokens: result.usage.inputTokens ?? 0,
    costUsd: costOf(result.usage),
  };
}
