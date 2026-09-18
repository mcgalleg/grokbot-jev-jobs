import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildApplyRequestPayload,
  buildCallbackUrl,
  canStartApply,
  shouldShowApplyDetail,
  shouldShowApplyStatusBadge,
  decideApplyPollTick,
  callbackSecretFrom,
  decideCallback,
  parseCallbackBody,
  parseRudyStatusQuery,
  settleFromStatuses,
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

describe('shouldShowApplyDetail', () => {
  it('is for blocked, failed, and skipped — not applying or applied', () => {
    assert.equal(shouldShowApplyDetail('blocked'), true);
    assert.equal(shouldShowApplyDetail('failed'), true);
    assert.equal(shouldShowApplyDetail('skipped'), true);
    assert.equal(shouldShowApplyDetail('applying'), false);
    assert.equal(shouldShowApplyDetail('applied'), false);
    assert.equal(shouldShowApplyDetail(null), false);
  });
});

describe('shouldShowApplyStatusBadge', () => {
  it('hides the title-row chip while applying so only the button spins', () => {
    assert.equal(shouldShowApplyStatusBadge('applying'), false);
    assert.equal(shouldShowApplyStatusBadge(null), false);
    assert.equal(shouldShowApplyStatusBadge(undefined), false);
    assert.equal(shouldShowApplyStatusBadge('applied'), true);
    assert.equal(shouldShowApplyStatusBadge('failed'), true);
    assert.equal(shouldShowApplyStatusBadge('blocked'), true);
    assert.equal(shouldShowApplyStatusBadge('skipped'), true);
  });
});

describe('decideApplyPollTick', () => {
  it('keeps polling only while the pointer is still applying', () => {
    assert.deepEqual(decideApplyPollTick({ status: 'applying', detail: null }), { action: 'continue' });
  });

  it('settles on a terminal write-back so the list can refresh', () => {
    assert.deepEqual(decideApplyPollTick({ status: 'applied', detail: null }), {
      action: 'settle',
      status: 'applied',
      detail: null,
    });
    assert.deepEqual(decideApplyPollTick({ status: 'failed', detail: 'webhook 502' }), {
      action: 'settle',
      status: 'failed',
      detail: 'webhook 502',
    });
    assert.deepEqual(decideApplyPollTick({ status: 'blocked', detail: 'knock-out' }), {
      action: 'settle',
      status: 'blocked',
      detail: 'knock-out',
    });
    assert.deepEqual(decideApplyPollTick({ status: 'skipped', detail: 'already in ATS' }), {
      action: 'settle',
      status: 'skipped',
      detail: 'already in ATS',
    });
  });

  it('settles when the pointer is gone so the spinner cannot hang', () => {
    assert.deepEqual(decideApplyPollTick({ status: null, detail: null }), {
      action: 'settle',
      status: null,
      detail: null,
    });
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
    assert.deepEqual(decideCallback({ ...base, activeStatus: 'blocked', nextStatus: 'blocked' }), {
      action: 'idempotent',
    });
  });

  it('lets a later applied overwrite blocked / failed / skipped for the same attempt', () => {
    assert.deepEqual(decideCallback({ ...base, activeStatus: 'blocked', nextStatus: 'applied' }), {
      action: 'accept',
    });
    assert.deepEqual(decideCallback({ ...base, activeStatus: 'failed', nextStatus: 'applied' }), {
      action: 'accept',
    });
    assert.deepEqual(decideCallback({ ...base, activeStatus: 'skipped', nextStatus: 'applied' }), {
      action: 'accept',
    });
  });

  it('refuses a lesser terminal overwriting applied, or a sideways hop', () => {
    assert.equal(decideCallback({ ...base, activeStatus: 'applied', nextStatus: 'blocked' }).action, 'reject');
    assert.equal(decideCallback({ ...base, activeStatus: 'applied', nextStatus: 'failed' }).action, 'reject');
    assert.equal(decideCallback({ ...base, activeStatus: 'applied', nextStatus: 'skipped' }).action, 'reject');
    assert.equal(decideCallback({ ...base, activeStatus: 'blocked', nextStatus: 'failed' }).action, 'reject');
    assert.equal(decideCallback({ ...base, activeStatus: 'failed', nextStatus: 'skipped' }).action, 'reject');
  });

  it('refuses a different attempt, a url mismatch, or a missing pointer', () => {
    assert.equal(
      decideCallback({ ...base, attemptId: '22222222-2222-4222-8222-222222222222' }).action,
      'reject',
    );
    assert.equal(decideCallback({ ...base, jobUrl: 'https://job.example/other' }).action, 'reject');
    assert.equal(decideCallback({ ...base, activeAttemptId: null, activeStatus: null }).action, 'reject');
  });
});

describe('settleFromStatuses', () => {
  it('lets applied correct applying or a lesser terminal, never applied itself', () => {
    assert.deepEqual(settleFromStatuses('applied'), ['applying', 'blocked', 'failed', 'skipped']);
    assert.deepEqual(settleFromStatuses('blocked'), ['applying']);
    assert.deepEqual(settleFromStatuses('failed'), ['applying']);
    assert.deepEqual(settleFromStatuses('skipped'), ['applying']);
    assert.equal(settleFromStatuses('applied').includes('applied'), false);
  });
});

describe('parseRudyStatusQuery', () => {
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const jobUrl = 'https://job.example/1';

  it('accepts attemptId, jobUrl, or both', () => {
    assert.deepEqual(parseRudyStatusQuery(new URLSearchParams({ attemptId })), { ok: true, attemptId });
    assert.deepEqual(parseRudyStatusQuery(new URLSearchParams({ jobUrl })), { ok: true, jobUrl });
    assert.deepEqual(parseRudyStatusQuery(new URLSearchParams({ attemptId, jobUrl })), {
      ok: true,
      attemptId,
      jobUrl,
    });
  });

  it('rejects a missing, empty, or malformed query', () => {
    assert.equal(parseRudyStatusQuery(new URLSearchParams()).ok, false);
    assert.equal(parseRudyStatusQuery(new URLSearchParams({ attemptId: 'nope' })).ok, false);
    assert.equal(parseRudyStatusQuery(new URLSearchParams({ jobUrl: 'not-a-url' })).ok, false);
  });
});
