import '../lib/env.ts';
import { experimental_evaluate as evaluate } from 'ai';

const t0 = Date.now();
const result = await evaluate({
  model: 'typesafe-ai/jev',
  state: {
    candidate: 'Principal Product Manager, 20 years in cybersecurity. Ships production AI features, writes TypeScript and Python, was a Unix admin and a consultant embedded with customers.',
    job: { title: 'Forward Deployed Engineer', company: 'acme', location: 'Remote - US' },
  },
  questions: {
    roleType: {
      type: 'choice',
      instructions: 'What kind of role is this?',
      criteria: {
        fde: 'forward deployed or customer-embedded engineering',
        aiPm: 'AI or data product management',
        swe: 'pure software engineering, no customer contact',
        other: 'none of these',
      },
    },
    seniority: {
      type: 'score',
      instructions: 'Rate the seniority of this role.',
      criteria: ['intern', 'entry', 'mid', 'senior', 'staff or principal'],
    },
    worthReading: {
      type: 'boolean',
      instructions: 'Is this posting worth fetching the full description for this candidate?',
    },
  },
});

console.log('latency_ms', Date.now() - t0);
console.log('answers', JSON.stringify(result.answers, null, 2));
console.log('usage', result.usage);
console.log('providerMetadata', JSON.stringify(result.providerMetadata, null, 2));
console.log('cost_usd', (result.usage.inputTokens ?? 0) * 0.042 / 1_000_000);
