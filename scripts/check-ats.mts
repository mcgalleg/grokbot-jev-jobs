/** Live check of every wired ATS fetcher against real rows. */
import '../lib/env.ts';
import { getSql } from '../lib/db/pg.ts';
import { fetchDescription, JobExpiredError, parseWorkdayUrl, SUPPORTED_ATS } from '../lib/ats.ts';

const sql = getSql();

console.log('=== Workday URL parsing ===');
const cases = [
  'https://acme.wd1.myworkdayjobs.com/external_careers/job/Denver-CO/Engineer_REQ_1',
  'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Remote/Staff-PM_R123',
  'https://acme.wd103.myworkdaysite.com/en-US/SiteName/job/Boulder/Analyst_R9',
  'https://jobs.ashbyhq.com/acme/1234abcd-0000-0000-0000-000000000000',
];
for (const c of cases) {
  const r = parseWorkdayUrl(c);
  console.log(' ', r ? `${r.company}|${r.wd}|${r.siteId}|${r.externalPath}` : 'null', '<-', c.slice(8, 70));
}

let ok = 0, expired = 0, failed = 0;
for (const ats of SUPPORTED_ATS) {
  const rows = (await sql.query(
    `SELECT url, title, company, ats FROM jobs WHERE ats = $1 ORDER BY company LIMIT 6`,
    [ats],
  )) as { url: string; title: string; company: string; ats: string }[];
  console.log(`\n=== ${ats} (${rows.length} samples) ===`);
  for (const row of rows) {
    try {
      const t0 = Date.now();
      const d = await fetchDescription(row.url, row.ats, row.company);
      ok++;
      console.log(`  OK ${String(Date.now() - t0).padStart(5)}ms ${d.text.length.toString().padStart(6)} chars  ${row.company} / ${row.title.trim().slice(0, 42)}`);
    } catch (e) {
      if (e instanceof JobExpiredError) { expired++; console.log(`  EXPIRED  ${row.company} / ${row.title.trim().slice(0, 42)}`); }
      else { failed++; console.log(`  FAIL     ${row.company}: ${(e as Error).message.slice(0, 95)}`); }
    }
  }
}
console.log(`\ntotals: ok=${ok} expired=${expired} failed=${failed}`);
