import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildApplyRequestPayload,
  buildCallbackUrl,
  canStartApply,
  callbackSecretFrom,
  decideCallback,
  parseCallbackBody,
  resolveAppBaseUrl,
  secretsMatch,
  UNIVERSAL_COVER_PATH,
  UNIVERSAL_RESUME_PATH,
  webhookAts,
} from './apply';

describe('canStartApply', () => {
  it('allows a first apply and retries, not applying or applied', () => {
    assert.equal(canStartApply(null), true);
    assert.equal(canStartApply(undefined), true);
    assert.equal(canStartApply('failed'), true);
    assert.equal(canStartApply('blocked'), true);
    assert.equal(canStartApply('skipped'), true);
    assert.equal(canStartApply('applying'), false);
    assert.equal(canStartApply('applied'), false);
  });
});

describe('webhookAts', () => {
  it('keeps the four wired boards and drops the rest', () => {
    assert.equal(webhookAts('Greenhouse'), 'Greenhouse');
    assert.equal(webhookAts('Ashby'), 'Ashby');
    assert.equal(webhookAts('Workday'), 'Workday');
    assert.equal(webhookAts('Lever'), 'Lever');
    assert.equal(webhookAts('BambooHR'), null);
    assert.equal(webhookAts(null), null);
  });
});

describe('resolveAppBaseUrl', () => {
  it('prefers APP_BASE_URL, then NEXT_PUBLIC_APP_URL, then VERCEL_URL', () => {
    assert.equal(
      resolveAppBaseUrl({
        APP_BASE_URL: 'https://jobs.example/',
        NEXT_PUBLIC_APP_URL: 'https://ignored.example',
        VERCEL_URL: 'ignored.vercel.app',
      }),
      'https://jobs.example',
    );
    assert.equal(
      resolveAppBaseUrl({
        NEXT_PUBLIC_APP_URL: 'https://preview.example',
        VERCEL_URL: 'ignored.vercel.app',
      }),
      'https://preview.example',
    );
    assert.equal(resolveAppBaseUrl({ VERCEL_URL: 'my-app.vercel.app' }), 'https://my-app.vercel.app');
    assert.equal(
      resolveAppBaseUrl({ VERCEL_URL: 'https://already-schemed.vercel.app' }),
      'https://already-schemed.vercel.app',
    );
    assert.equal(resolveAppBaseUrl({}), 'http://localhost:3000');
  });
});

describe('buildCallbackUrl', () => {
  it('points at the write-back route and optionally appends the Vercel bypass', () => {
    assert.equal(
      buildCallbackUrl({ APP_BASE_URL: 'https://jobs.example' }),
      'https://jobs.example/api/webhooks/rudy-apply',
    );
    assert.equal(
      buildCallbackUrl({
        APP_BASE_URL: 'https://jobs.example',
        VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-token',
      }),
      'https://jobs.example/api/webhooks/rudy-apply?x-vercel-protection-bypass=bypass-token',
    );
  });
});

describe('buildApplyRequestPayload', () => {
  it('sends the universal CV and cover, never a per-company letter', () => {
    const payload = buildApplyRequestPayload({
      attemptId: '11111111-1111-4111-8111-111111111111',
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      title: 'Forward Deployed Engineer',
      company: 'Acme',
      ats: 'Greenhouse',
      location: 'Remote, US',
      fitScore: 7.2,
      generatedAt: '2026-09-18T12:00:00.000Z',
      env: { APP_BASE_URL: 'https://jobs.example' },
    });
    assert.deepEqual(payload, {
      source: 'jev-job-search',
      event: 'apply-request',
      attemptId: '11111111-1111-4111-8111-111111111111',
      jobUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      title: 'Forward Deployed Engineer',
      company: 'Acme',
      ats: 'Greenhouse',
      location: 'Remote, US',
      fitScore: 7.2,
      resumePath: UNIVERSAL_RESUME_PATH,
      coverPath: UNIVERSAL_COVER_PATH,
      callbackUrl: 'https://jobs.example/api/webhooks/rudy-apply',
      generatedAt: '2026-09-18T12:00:00.000Z',
    });
    assert.match(payload.resumePath, /mike-gallegos-cv\.pdf$/);
    assert.match(payload.coverPath, /universal-cover-letter\.pdf$/);
  });
});

describe('parseCallbackBody', () => {
  const valid = {
    attemptId: '11111111-1111-4111-8111-111111111111',
    jobUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    status: 'applied',
    detail: 'submitted',
    occurredAt: '2026-09-18T12:01:00.000Z',
  };

  it('accepts a well-formed write-back', () => {
    const parsed = parseCallbackBody(valid);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.body.status, 'applied');
      assert.equal(parsed.body.detail, 'submitted');
    }
  });

  it('rejects applying (only Rudy terminal statuses write back)', () => {
    const parsed = parseCallbackBody({ ...valid, status: 'applying' });
    assert.equal(parsed.ok, false);
  });

  it('rejects a bad uuid or date', () => {
    assert.equal(parseCallbackBody({ ...valid, attemptId: 'nope' }).ok, false);
    assert.equal(parseCallbackBody({ ...valid, occurredAt: 'yesterday' }).ok, false);
  });
});

describe('callback secrets', () => {
  it('reads Bearer first, then x-rudy-secret', () => {
    assert.equal(
      callbackSecretFrom(new Headers({ authorization: 'Bearer alpha', 'x-rudy-secret': 'beta' })),
      'alpha',
    );
    assert.equal(callbackSecretFrom(new Headers({ 'x-rudy-secret': 'beta' })), 'beta');
    assert.equal(callbackSecretFrom(new Headers()), null);
  });

  it('compares secrets in constant time and refuses empties', () => {
    assert.equal(secretsMatch('secret', 'secret'), true);
    assert.equal(secretsMatch('secret', 'other0'), false);
    assert.equal(secretsMatch(null, 'secret'), false);
    assert.equal(secretsMatch('secret', undefined), false);
  });
});

describe('decideCallback', () => {
  const base = {
    activeAttemptId: '11111111-1111-4111-8111-111111111111',
    activeJobUrl: 'https://job.example/1',
    activeStatus: 'applying' as const,
    attemptId: '11111111-1111-4111-8111-111111111111',
    jobUrl: 'https://job.example/1',
    nextStatus: 'applied' as const,
  };

  it('accepts applying → terminal', () => {
    assert.deepEqual(decideCallback(base), { action: 'accept' });
  });

  it('is idempotent on a duplicate terminal', () => {
    assert.deepEqual(decideCallback({ ...base, activeStatus: 'applied' }), { action: 'idempotent' });
  });

  it('refuses a different attempt or a second terminal hop', () => {
    assert.equal(
      decideCallback({ ...base, attemptId: '22222222-2222-4222-8222-222222222222' }).action,
      'reject',
    );
    assert.equal(decideCallback({ ...base, activeStatus: 'failed', nextStatus: 'applied' }).action, 'reject');
    assert.equal(decideCallback({ ...base, activeAttemptId: null, activeStatus: null }).action, 'reject');
  });
});
