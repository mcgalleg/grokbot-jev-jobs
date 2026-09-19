import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  humanize,
  isDestructive,
  labelsToCriteria,
  parsePageBrainBody,
  summarizeInput,
  uniqueLabels,
} from './page-brain';

describe('parsePageBrainBody', () => {
  it('accepts each mode with its required fields', () => {
    const cases = [
      { mode: 'next-action', pageSummary: 'step 2', visibleActions: ['Next'] },
      { mode: 'knock-out', question: 'Do you need sponsorship?', options: ['Yes', 'No'] },
      { mode: 'field-map', neededKey: 'phone', fieldLabels: ['Phone'] },
      { mode: 'outcome', pageSummary: 'Thank you for applying' },
    ];
    for (const body of cases) {
      const r = parsePageBrainBody(body);
      assert.equal(r.ok, true, JSON.stringify(body));
    }
  });

  it('rejects a missing or unknown mode, and non-objects', () => {
    assert.equal(parsePageBrainBody({ pageSummary: 'x' }).ok, false);
    assert.equal(parsePageBrainBody({ mode: 'submit' }).ok, false);
    assert.equal(parsePageBrainBody([]).ok, false);
    assert.equal(parsePageBrainBody(null).ok, false);
  });

  it('lets the CLI --mode flag override the body', () => {
    const r = parsePageBrainBody({ mode: 'outcome', neededKey: 'phone', fieldLabels: ['Phone'] }, 'field-map');
    assert.ok(r.ok && r.input.mode === 'field-map');
  });

  it('names every missing or mistyped field', () => {
    const r = parsePageBrainBody({ mode: 'next-action', visibleActions: 'Next' });
    assert.ok(!r.ok);
    assert.match(r.error, /pageSummary is required/);
    assert.match(r.error, /visibleActions must be an array of strings/);
  });

  it('refuses an empty action or field list once blanks are dropped', () => {
    const r = parsePageBrainBody({ mode: 'field-map', neededKey: 'phone', fieldLabels: ['  ', ''] });
    assert.ok(!r.ok);
    assert.match(r.error, /fieldLabels must not be empty/);
  });

  it('allows a knock-out with no options, as a free-text question', () => {
    const r = parsePageBrainBody({ mode: 'knock-out', question: 'Earliest start date?' });
    assert.ok(r.ok && r.input.mode === 'knock-out' && r.input.options.length === 0);
  });

  it('maps the legacy outcome `evidence` field to pageSummary', () => {
    const r = parsePageBrainBody({ mode: 'outcome', evidence: 'Application received' });
    assert.ok(r.ok && r.input.mode === 'outcome' && r.input.pageSummary === 'Application received');
  });

  it('caps page text so an oversized page cannot run up the bill', () => {
    const r = parsePageBrainBody({ mode: 'outcome', pageSummary: 'x'.repeat(50_000) });
    assert.ok(r.ok && r.input.mode === 'outcome' && r.input.pageSummary.length === 8_000);
  });
});

describe('isDestructive', () => {
  it('vetoes actions that abandon or destroy the application', () => {
    for (const a of ['Cancel application', 'Withdraw', 'Delete draft', 'Discard', 'Remove resume', 'Sign out', 'Log out']) {
      assert.equal(isDestructive(a), true, a);
    }
  });

  it('leaves progressive actions to Jev', () => {
    for (const a of ['Continue', 'Save and Continue', 'Submit Application', 'Upload resume', 'Back']) {
      assert.equal(isDestructive(a), false, a);
    }
  });

  it('matches whole words, not substrings', () => {
    assert.equal(isDestructive('Cancellation policy'), false);
  });
});

describe('labels', () => {
  it('trims, drops blanks and de-duplicates in first-seen order', () => {
    assert.deepEqual(uniqueLabels([' Next ', 'Back', '', 'Next']), ['Next', 'Back']);
  });

  it('keys Choice criteria by the exact label', () => {
    assert.deepEqual(labelsToCriteria(['Yes', 'No', 'Yes']), { Yes: 'Yes', No: 'No' });
  });
});

describe('humanize', () => {
  it('turns profile keys into words', () => {
    assert.equal(humanize('yearsExperience'), 'years experience');
    assert.equal(humanize('linkedin_url'), 'linkedin url');
    assert.equal(humanize('phone'), 'phone');
  });
});

describe('summarizeInput', () => {
  it('records that facts were overridden without logging them', () => {
    const r = parsePageBrainBody({
      mode: 'knock-out',
      question: 'Clearance?',
      options: ['Yes', 'No'],
      candidateFacts: 'private detail',
    });
    assert.ok(r.ok);
    const summary = summarizeInput(r.input);
    assert.equal(summary.candidateFactsOverride, true);
    assert.equal(JSON.stringify(summary).includes('private detail'), false);
  });
});
