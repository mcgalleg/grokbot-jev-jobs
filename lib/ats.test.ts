import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { icimsLocation, icimsPlace, platformOf } from './ats';
import { locationOk, screen } from './screen';

/** The shape of an iCIMS `in_iframe=1` page, cut down to the parts read. */
function page({
  header = {},
  address,
  locationType,
}: {
  header?: Record<string, string>;
  address?: Record<string, string>;
  locationType?: string;
}): string {
  const ld = {
    '@context': 'http://schema.org',
    '@type': 'JobPosting',
    description: '<p>Do the work.</p>',
    ...(locationType ? { jobLocationType: locationType } : {}),
    jobLocation: address ? [{ '@type': 'Place', address }] : [],
  };
  const rows = Object.entries(header)
    .map(
      ([label, value]) => `<div class="iCIMS_JobHeaderTag">
<dt class="iCIMS_JobHeaderField"><span class="sr-only field-label">${label}</span>
</dt>
<dd class="iCIMS_JobHeaderData"><span >
${value}</span>
</dd>
</div>`,
    )
    .join('\n');
  return `<script type="application/ld+json">${JSON.stringify(ld)}</script>
<div class="iCIMS_JobHeaderGroup"><dl>${rows}</dl></div>`;
}

const UNAVAILABLE = 'UNAVAILABLE';

describe('icimsPlace', () => {
  it('turns COUNTRY-REGION-CITY round', () => {
    assert.equal(icimsPlace('US-CO-Denver'), 'Denver, CO, US');
    assert.equal(icimsPlace('US-NC-Winston-Salem'), 'Winston-Salem, NC, US');
    assert.equal(icimsPlace('TX-HOUSTON'), 'HOUSTON, TX');
  });

  it('leaves anything else alone', () => {
    assert.equal(icimsPlace('Cheshire-Warrington'), 'Cheshire-Warrington');
    assert.equal(icimsPlace('Denver'), 'Denver');
  });
});

describe('icimsLocation', () => {
  it('prefers the header row the company typed', () => {
    const html = page({
      header: { 'Job Locations': 'US-CO-Golden' },
      address: { addressLocality: 'Elsewhere', addressRegion: 'TX', addressCountry: 'US' },
    });
    assert.deepEqual(icimsLocation(html), { location: 'Golden, CO, US', remote: false });
  });

  it('falls back to the JSON-LD address, skipping UNAVAILABLE', () => {
    const html = page({
      address: { addressLocality: UNAVAILABLE, addressRegion: 'TN', addressCountry: 'US' },
    });
    assert.deepEqual(icimsLocation(html), { location: 'TN, US', remote: false });
  });

  it('reports no location when every field is UNAVAILABLE', () => {
    const html = page({
      address: { addressLocality: UNAVAILABLE, addressRegion: UNAVAILABLE, addressCountry: UNAVAILABLE },
    });
    assert.deepEqual(icimsLocation(html), { location: undefined, remote: false });
  });

  it('reads remote from TELECOMMUTE or a Telecommute: Yes row', () => {
    assert.equal(icimsLocation(page({ locationType: 'TELECOMMUTE' })).remote, true);
    assert.equal(icimsLocation(page({ header: { Telecommute: 'Yes' } })).remote, true);
    assert.equal(icimsLocation(page({ header: { Telecommute: 'No' } })).remote, false);
  });

  it('ignores the linked location-name row', () => {
    const html = page({ header: { 'Location : Name Linked': 'B&amp;Q Warrington' } });
    assert.equal(icimsLocation(html).location, undefined);
  });
});

describe('deferred location screen', () => {
  const job = {
    url: 'https://careers-acme.icims.com/jobs/1/engineer/job',
    title: 'Engineer',
    company: 'acme',
    location: 'Not specified',
    remote: false,
    ats: 'iCIMS',
  };

  it('lets an iCIMS posting with no location through stage 0', () => {
    assert.deepEqual(screen(job), { keep: true });
  });

  it('still drops other platforms with no location', () => {
    assert.deepEqual(screen({ ...job, ats: 'BambooHR' }), { keep: false, reason: 'location' });
  });

  it('matches the turned-round iCIMS location against the metro terms', () => {
    assert.equal(locationOk(icimsPlace('US-CO-Littleton'), false), true);
    assert.equal(locationOk(icimsPlace('US-TX-Austin'), false), false);
    assert.equal(locationOk(icimsPlace('US-TX-Austin'), true), true);
  });

  it('routes iCIMS URLs to the iCIMS fetcher', () => {
    assert.equal(platformOf(null, job.url), 'iCIMS');
  });
});
