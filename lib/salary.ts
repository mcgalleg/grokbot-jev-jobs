/**
 * Salary ranges stated in a posting, found in code.
 *
 * Jev reads numbers as text, and TypeSafe's own guidance is to keep arithmetic
 * in code. Asking it "is the top of the range below the floor?" missed 43 of
 * 1,239 postings with a parseable range, one topping out at $100k, and it flagged
 * 516 postings that state no range at all, reading "$400M in ARR" or a "$67
 * monthly allowance" as pay. So code finds every dollar range, Jev only picks
 * which one is this role's pay, and code does the comparison.
 *
 * Search runs over the full description, not the truncated copy Jev reads:
 * pay-transparency blurbs sit at the end, and 174 long postings had their only
 * salary figure past the cut.
 */

export interface SalaryRange {
  /** Human label, also the Choice option key: "$150,000 – $200,000". */
  label: string;
  min: number;
  max: number;
  /** The text around the range, so Jev can tell base pay from OTE or equity. */
  context: string;
}

/**
 * $150,000, $127,460.25, $150k, $150.5K, and the same without the dollar sign.
 * Hourly figures ($60) do not match, by design.
 */
const CURRENCIES = 'USD|CAD|GBP|EUR|AUD|NZD|INR|SGD|JPY|CHF|MXN|BRL|ILS|PLN';
const AMOUNT = String.raw`(\$)?\s?(\d{2,3}(?:,\d{3})+(?:\.\d{2})?|\d{2,3}(?:\.\d+)?\s?[kK])`;
const RANGE = new RegExp(
  `${AMOUNT}\\s*(?:USD)?\\s*(?:-|–|—|to)\\s*(?:USD\\s*)?${AMOUNT}(\\s*(?:${CURRENCIES})\\b)?`,
  'g',
);
/** A range with no dollar sign counts only when the words around it are about pay. */
const PAY_WORDS = /salary|compensation|pay|annual|per year|a year|base|OTE|USD/i;

const MAX_CANDIDATES = 8;

function toNumber(raw: string): number {
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return /k/i.test(raw) ? n * 1000 : n;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function findSalaryRanges(text: string): SalaryRange[] {
  const seen = new Set<string>();
  const out: SalaryRange[] = [];
  for (const m of text.matchAll(RANGE)) {
    const [, dollarLo, lo, dollarHi, hi, currency] = m;
    // A CAD or GBP range cannot be compared with a USD floor.
    if (currency && currency.trim() !== 'USD') continue;
    const min = toNumber(lo);
    const max = toNumber(hi);
    // Annual salaries only. Anything else is a revenue figure, a headcount, or
    // a typo, and is not worth a question.
    if (min < 30_000 || max > 2_000_000 || max < min) continue;
    const near = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 30);
    if (!dollarLo && !dollarHi && !PAY_WORDS.test(near)) continue;
    const label = `${usd(min)} – ${usd(max)}`;
    if (seen.has(label)) continue;
    seen.add(label);
    const start = Math.max(0, m.index - 160);
    const context = text
      .slice(start, m.index + m[0].length + 60)
      .replace(/\s+/g, ' ')
      .trim();
    out.push({ label, min, max, context });
    if (out.length === MAX_CANDIDATES) break;
  }
  return out;
}
