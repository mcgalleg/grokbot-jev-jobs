import type { Experimental_EvaluationQuestion as EvaluationQuestion } from 'ai';
import { EVIDENCE_RULE, askJev, costOf } from './model';
import { ROLE_CRITERIA } from './triage';
import { htmlToText, looksLikeHtml } from '../ats';
import { loadProfile, salaryFloor } from '../profile';
import { findSalaryRanges, type SalaryRange } from '../salary';

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
  /** What code found and decided about pay, kept for inspection. */
  salary: { floor: number | null; ranges: Omit<SalaryRange, 'context'>[] };
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

/**
 * Hard requirements the candidate cannot meet, one Noul each. They used to be
 * one bundled question, which hid which condition fired and let a partial match
 * on one dilute the others. Combined with max(): any one is disqualifying.
 */
const BLOCKERS = {
  clearance: {
    type: 'boolean',
    instructions: `Does \`posting.description\` require the hire to hold a security clearance, or to obtain one, as a condition of the job? ${EVIDENCE_RULE}`,
    criteria: {
      true: 'an active clearance such as Secret or TS/SCI is required, or the hire must be eligible for and obtain one',
      false: 'no clearance is required, or a clearance is only preferred, or clearances are mentioned only about customers or the company',
    },
  },
  degree: {
    type: 'boolean',
    instructions: `Does \`posting.description\` make a specific degree a hard requirement, with no equivalent-experience alternative? ${EVIDENCE_RULE}`,
    criteria: {
      true: "a master's or PhD is required, or a bachelor's in a named technical field such as computer science is required, and equivalent experience is not accepted",
      false: "no degree is required, any bachelor's degree is enough, the degree is only preferred, or equivalent experience is accepted",
    },
  },
  relocation: {
    type: 'boolean',
    instructions: `Does \`posting.description\` require the hire to relocate? ${EVIDENCE_RULE}`,
    criteria: {
      true: 'the hire must move to a named city or country to take the job',
      false: 'the role is remote, or no move is required',
    },
  },
  foreignWorkAuth: {
    type: 'boolean',
    instructions: `Does \`posting.description\` require citizenship, residency, or work authorization in a country other than the United States? ${EVIDENCE_RULE}`,
    criteria: {
      true: 'the hire must be a citizen or resident of, or authorized to work in, a country other than the United States',
      false: 'the role is open to United States workers, or states no such requirement',
    },
  },
} as const;
export type Blocker = keyof typeof BLOCKERS;

const NO_PAY_RANGE = 'none';

export async function scoreJob(job: ScoreInput): Promise<ScoreOutput> {
  const profile = loadProfile();
  const floor = salaryFloor();

  // Greenhouse descriptions stored before the htmlToText fix still carry markup:
  // about a fifth of their tokens, and noise Jev has to read past.
  const text = looksLikeHtml(job.description) ? htmlToText(job.description) : job.description;
  const ranges = floor === null ? [] : findSalaryRanges(text);

  // Any cash figure caps the base: if OTE or total cash tops out below the floor,
  // the base does too. So the question is which range is this role's cash pay,
  // and code compares its top to the floor.
  const payRange: Record<string, EvaluationQuestion> = ranges.length
    ? {
        payRange: {
          type: 'choice' as const,
          instructions: `Which entry in \`salaryRanges\` is the cash pay range for this role (base salary, on-target earnings, or total cash) for a candidate working remotely from Colorado? If only one range is pay, choose it. ${EVIDENCE_RULE}`,
          criteria: {
            ...Object.fromEntries(ranges.map((r) => [r.label, r.label])),
            [NO_PAY_RANGE]: 'no entry in `salaryRanges` is cash pay for this role',
          },
        },
      }
    : {};

  const result = await askJev({
    state: {
      candidateResume: profile.resume,
      whatTheCandidateWants: profile.targets,
      posting: {
        title: job.title,
        company: job.company,
        location: job.location ?? 'unspecified',
        description: text.slice(0, MAX_DESCRIPTION_CHARS),
      },
      // Found in code over the full text, with the words around each range.
      ...(ranges.length
        ? { salaryRanges: ranges.map((r) => ({ range: r.label, context: r.context })) }
        : {}),
    },
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
      ...BLOCKERS,
    },
    extra: payRange,
  });

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

  const blockerProbability = Math.max(
    ...(Object.keys(BLOCKERS) as Blocker[]).map((k) => a[k].probability),
  );

  // The probability that the base salary is below the floor: the Choice mass on
  // ranges whose top, compared in code, falls short. No stated range means no
  // penalty; silence is the common case and costs nothing.
  const salaryAnswer = (a as Record<string, unknown>).payRange as
    | { choice: string; probabilities?: Record<string, number> }
    | undefined;
  const compBelowFloorProbability =
    floor === null || !salaryAnswer
      ? 0
      : ranges
          .filter((r) => r.max < floor)
          .reduce(
            (sum, r) =>
              sum +
              (salaryAnswer.probabilities?.[r.label] ?? (salaryAnswer.choice === r.label ? 1 : 0)),
            0,
          );

  const raw = Object.values(components).reduce((sum, v) => sum + v, 0);
  // A hard blocker, a bad location, or a stated base below the floor scales the
  // whole score down rather than zeroing it, so a near-miss stays visible in the
  // ranking for review.
  const penalty =
    (1 - blockerProbability * 0.9) *
    (0.25 + 0.75 * a.locationOk.probability) *
    (1 - compBelowFloorProbability * 0.8);

  const meta = result.providerMetadata?.typesafe as
    | { confidence?: Record<string, number> }
    | undefined;
  const confidences = Object.values(meta?.confidence ?? {});

  return {
    fitScore: Number((raw * penalty).toFixed(2)),
    confidence: confidences.length
      ? confidences.reduce((x, y) => x + y, 0) / confidences.length
      : 0,
    blockerProbability,
    compBelowFloorProbability,
    motion: a.motion.choice,
    preSalesProbability: a.motion.probabilities?.preSales ?? (a.motion.choice === 'preSales' ? 1 : 0),
    answers: {
      ...a,
      // Same shape the dashboard already reads, now decided in code.
      compBelowFloor: { type: 'boolean', probability: compBelowFloorProbability },
    },
    components,
    salary: { floor, ranges: ranges.map(({ label, min, max }) => ({ label, min, max })) },
    inputTokens: result.usage.inputTokens ?? 0,
    costUsd: costOf(result.usage),
  };
}
