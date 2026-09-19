/**
 * Stage 2: fetch the full job description.
 *
 * The upstream feed carries no descriptions, so we go back to the applicant
 * tracking system for the postings that survive triage. Greenhouse, Lever and
 * Ashby all expose a public JSON API keyed off the slug and id already encoded
 * in the posting URL, which is why the proof of concept starts with those three.
 * Workday, BambooHR, iCIMS and Paylocity need more work and are stubbed.
 */

export interface FetchedDescription {
  text: string;
  source: string;
}

export class UnsupportedAtsError extends Error {}
/** The posting is no longer on the board. The feed keeps jobs for 30 days, so this is routine. */
export class JobExpiredError extends Error {}

const htmlEntities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•',
};

const ESCAPED_TAG = /&lt;\/?[a-z][\s\S]*?&gt;/i;
const unescapeMarkup = (s: string) =>
  s.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&amp;/gi, '&');

/**
 * Markup or entities that survive in text: real tags, escaped ones
 * (`&lt;p&gt;`), or bare entities such as `&mdash;` between two salary figures.
 */
export function looksLikeHtml(text: string): boolean {
  return (
    /<\/?(p|div|br|li|ul|span|strong|h[1-6])\b[^>]*>/i.test(text) ||
    ESCAPED_TAG.test(text) ||
    /&(#x?[0-9a-f]+|[a-z]+);/i.test(text)
  );
}

/**
 * Good enough for feeding a model: keep the words and the block structure.
 *
 * Greenhouse's board API returns `content` HTML-escaped. Decoding entities after
 * stripping tags turned `&lt;p&gt;` back into `<p>` and stored it, which left
 * markup in over half the descriptions. So escaped markup is unescaped first,
 * twice at most, because a few boards double-escape.
 */
export function htmlToText(input: string): string {
  let html = input;
  for (let i = 0; i < 2 && ESCAPED_TAG.test(html); i++) html = unescapeMarkup(html);
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
      const key = code.toLowerCase();
      if (htmlEntities[key]) return htmlEntities[key];
      if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)));
      return m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

async function getJson(
  url: string,
  init: { headers?: Record<string, string>; method?: string; body?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  const { timeoutMs = 20_000, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: 'application/json',
      'user-agent': 'jev-job-search/0.1 (personal job search)',
      ...headers,
    },
  });
  if (!res.ok) throw new HttpError(`HTTP ${res.status} for ${url}`, res.status);
  return res.json();
}

/**
 * Retry on 429, 5xx and network failures. `alsoRetry` adds statuses that are
 * ambiguous on a given platform: Workday answers 403 both when it is throttling
 * and when a requisition has been withdrawn, so we retry before concluding the
 * posting is gone.
 */
async function getJsonWithRetry(
  url: string,
  init?: Parameters<typeof getJson>[1],
  { attempts = 3, alsoRetry = [] as number[] } = {},
): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await getJson(url, init);
    } catch (error) {
      last = error;
      const status = error instanceof HttpError ? error.statusCode : 0;
      const retryable =
        status === 429 || status >= 500 || status === 0 || alsoRetry.includes(status);
      if (!retryable || i === attempts - 1) throw error;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i * (0.5 + Math.random())));
    }
  }
  throw last;
}

/**
 * Board-style platforms expose a whole-board endpoint that includes
 * descriptions, so we fetch a company once and serve every surviving posting
 * from that copy. Triage output clusters by company, which makes this a large
 * saving over one request per job. Workday has no such endpoint and is not
 * cached here.
 *
 * The cache is bounded. A single large board carries several megabytes of
 * description text (Databricks alone is ~7 MB), and a full backfill touches
 * thousands of companies, so an unbounded map would grow into gigabytes.
 * Because the fetch step processes rows sorted by company, only the boards
 * currently in flight matter, and a small LRU keeps the hit rate while capping
 * memory at roughly 50 MB.
 */
const MAX_CACHED_BOARDS = 8;
const boards = new Map<string, Promise<Map<string, string>>>();

function board(key: string, load: () => Promise<Map<string, string>>): Promise<Map<string, string>> {
  const cached = boards.get(key);
  if (cached) {
    // Refresh recency: delete then re-set moves the key to the end of the Map.
    boards.delete(key);
    boards.set(key, cached);
    return cached;
  }

  const pending = load().catch((error) => {
    boards.delete(key); // Never cache a failure; the next job retries.
    // A 404 on the *board* endpoint means the board itself is gone or the feed's
    // company slug never matched one. That is not a fault to investigate, it is
    // the same dead end as a withdrawn posting, and calling it an error buries
    // the real ones in the nightly summary.
    if (error instanceof HttpError && error.statusCode === 404) {
      throw new JobExpiredError(`board ${key} does not exist (HTTP 404)`);
    }
    throw error;
  });
  boards.set(key, pending);

  while (boards.size > MAX_CACHED_BOARDS) {
    const oldest = boards.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    boards.delete(oldest);
  }
  return pending;
}

/** Test seam: how many boards are currently held. */
export const cachedBoardCount = () => boards.size;

// ---------------------------------------------------------------- Greenhouse

const GREENHOUSE_URL = /greenhouse\.io\/(?:embed\/job_app\?for=)?([^/?#]+)\/jobs\/(\d+)/i;
/** Companies that white-label Greenhouse onto their own domain keep the id in ?gh_jid=. */
const GREENHOUSE_JID = /[?&]gh_jid=(\d+)/i;

/**
 * `companySlug` is the feed's company field, which for Greenhouse is the board
 * token. It is only needed for white-labelled career sites, where the token is
 * absent from the URL.
 */
async function greenhouse(url: string, companySlug?: string | null): Promise<FetchedDescription> {
  const m = url.match(GREENHOUSE_URL);
  const jid = url.match(GREENHOUSE_JID);
  if (!m && !(jid && companySlug)) {
    throw new UnsupportedAtsError(`Unrecognised Greenhouse URL: ${url}`);
  }
  const slug = m ? m[1] : companySlug!;
  const id = m ? m[2] : jid![1];
  const map = await board(`gh:${slug}`, async () => {
    const data = (await getJsonWithRetry(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
    )) as { jobs?: { id?: number | string; content?: string }[] };
    const out = new Map<string, string>();
    for (const job of data.jobs ?? []) {
      if (job.id != null && job.content) out.set(String(job.id), htmlToText(job.content));
    }
    return out;
  });
  const text = map.get(id);
  if (!text) throw new JobExpiredError(`Greenhouse board ${slug} no longer lists job ${id}`);
  return { text, source: 'greenhouse-board-api' };
}

// --------------------------------------------------------------------- Lever

const LEVER_URL = /jobs\.(?:eu\.)?lever\.co\/([^/?#]+)\/([0-9a-f-]{8,})/i;

function leverText(data: {
  description?: string;
  descriptionPlain?: string;
  lists?: { text?: string; content?: string }[];
  additional?: string;
}): string {
  return [
    data.descriptionPlain ?? (data.description ? htmlToText(data.description) : ''),
    ...(data.lists ?? []).map((l) => `\n${l.text ?? ''}\n${htmlToText(l.content ?? '')}`),
    data.additional ? htmlToText(data.additional) : '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function lever(url: string): Promise<FetchedDescription> {
  const m = url.match(LEVER_URL);
  if (!m) throw new UnsupportedAtsError(`Unrecognised Lever URL: ${url}`);
  const [, slug, id] = m;
  const map = await board(`lv:${slug}`, async () => {
    const data = (await getJsonWithRetry(`https://api.lever.co/v0/postings/${slug}?mode=json`)) as
      ({ id?: string } & Parameters<typeof leverText>[0])[];
    const out = new Map<string, string>();
    for (const job of data ?? []) {
      const text = leverText(job);
      if (job.id && text) out.set(job.id, text);
    }
    return out;
  });
  const text = map.get(id);
  if (!text) throw new JobExpiredError(`Lever board ${slug} no longer lists job ${id}`);
  return { text, source: 'lever-board-api' };
}

// --------------------------------------------------------------------- Ashby

const ASHBY_URL = /jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{8,})/i;

async function ashby(url: string): Promise<FetchedDescription> {
  const m = url.match(ASHBY_URL);
  if (!m) throw new UnsupportedAtsError(`Unrecognised Ashby URL: ${url}`);
  const [, slug, id] = m;
  const map = await board(`ab:${slug}`, async () => {
    const data = (await getJsonWithRetry(
      `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    )) as { jobs?: { id?: string; descriptionHtml?: string; descriptionPlain?: string }[] };
    const out = new Map<string, string>();
    for (const job of data.jobs ?? []) {
      const body = job.descriptionPlain ?? (job.descriptionHtml ? htmlToText(job.descriptionHtml) : '');
      if (job.id && body) out.set(job.id, body);
    }
    return out;
  });
  const text = map.get(id);
  if (!text) throw new JobExpiredError(`Ashby board ${slug} no longer lists job ${id}`);
  return { text, source: 'ashby-board-api' };
}

// ------------------------------------------------------------------- Workday

const WORKDAY_HOST = /^([^.]+)\.(wd\d+)\.(myworkdayjobs|myworkdaysite)\.com$/i;

interface WorkdayRef {
  company: string;
  wd: string;
  host: string;
  siteId: string;
  externalPath: string;
}

/**
 * Public URL:  https://{co}.wd1.myworkdayjobs.com/[locale/]{site}/job/{Loc}/{Title}_{REQ}
 * Detail API:  https://{co}.wd1.myworkdayjobs.com/wday/cxs/{co}/{site}/job/{Loc}/{Title}_{REQ}
 *
 * The locale segment is optional and absent from the API path, so we locate
 * `/job/` and treat the segment immediately before it as the site id.
 */
export function parseWorkdayUrl(url: string): WorkdayRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.match(WORKDAY_HOST);
  if (!host) return null;

  const marker = parsed.pathname.indexOf('/job/');
  if (marker < 0) return null;
  const prefix = parsed.pathname.slice(0, marker).split('/').filter(Boolean);
  const siteId = prefix.at(-1);
  if (!siteId) return null;

  return {
    company: host[1],
    wd: host[2],
    host: parsed.hostname,
    siteId,
    externalPath: parsed.pathname.slice(marker),
  };
}

/**
 * Workday has no board endpoint that carries descriptions, so this is one
 * request per posting rather than one per company. It is also the most
 * rate-sensitive platform, which is why the fetch script gives it its own
 * lower concurrency cap.
 */
async function workday(url: string): Promise<FetchedDescription> {
  const ref = parseWorkdayUrl(url);
  if (!ref) throw new UnsupportedAtsError(`Unrecognised Workday URL: ${url}`);

  const origin = `https://${ref.host}`;
  const api = `${origin}/wday/cxs/${ref.company}/${ref.siteId}${ref.externalPath}`;

  let data: { jobPostingInfo?: { jobDescription?: string; title?: string } };
  try {
    data = (await getJsonWithRetry(
      api,
      {
        headers: {
          'user-agent': BROWSER_UA,
          origin,
          referer: `${origin}/${ref.siteId}`,
        },
      },
      { alsoRetry: [403] },
    )) as typeof data;
  } catch (error) {
    // A withdrawn requisition answers 403, not 404, and stays 403 across
    // retries; genuine throttling clears. Either way the posting is unusable,
    // so it lands in the expired bucket rather than the error bucket.
    if (error instanceof HttpError && (error.statusCode === 403 || error.statusCode === 404)) {
      throw new JobExpiredError(
        `Workday will not serve ${ref.externalPath} (HTTP ${error.statusCode})`,
      );
    }
    throw error;
  }

  const html = data.jobPostingInfo?.jobDescription;
  if (!html) throw new JobExpiredError(`Workday returned no description for ${ref.externalPath}`);
  return { text: htmlToText(html), source: 'workday-cxs-api' };
}

// ------------------------------------------------------------------ dispatch

export const SUPPORTED_ATS = ['Greenhouse', 'Lever', 'Ashby', 'Workday'] as const;

export type Platform = (typeof SUPPORTED_ATS)[number];

/**
 * Per-platform request ceilings, borrowed from the aggregator's tuning.
 * Workday is the tightest limiter and is also the only platform billed one
 * request per posting rather than one per company.
 */
export const PLATFORM_CONCURRENCY: Record<Platform, number> = {
  Greenhouse: 8,
  Lever: 8,
  Ashby: 4,
  Workday: 3,
};

/** Which fetcher will handle this row, or null if none will. */
export function platformOf(ats: string | null | undefined, url: string): Platform | null {
  if (ats && (SUPPORTED_ATS as readonly string[]).includes(ats)) return ats as Platform;
  if (GREENHOUSE_URL.test(url) || GREENHOUSE_JID.test(url)) return 'Greenhouse';
  if (LEVER_URL.test(url)) return 'Lever';
  if (ASHBY_URL.test(url)) return 'Ashby';
  if (parseWorkdayUrl(url)) return 'Workday';
  return null;
}

export function isSupported(ats: string | null | undefined, url: string): boolean {
  if (ats && (SUPPORTED_ATS as readonly string[]).includes(ats)) return true;
  return (
    GREENHOUSE_URL.test(url) ||
    GREENHOUSE_JID.test(url) ||
    LEVER_URL.test(url) ||
    ASHBY_URL.test(url) ||
    parseWorkdayUrl(url) !== null
  );
}

export async function fetchDescription(
  url: string,
  ats?: string | null,
  companySlug?: string | null,
): Promise<FetchedDescription> {
  if (ats === 'Greenhouse' || GREENHOUSE_URL.test(url) || GREENHOUSE_JID.test(url)) {
    return greenhouse(url, companySlug);
  }
  if (ats === 'Lever' || LEVER_URL.test(url)) return lever(url);
  if (ats === 'Ashby' || ASHBY_URL.test(url)) return ashby(url);
  if (ats === 'Workday' || parseWorkdayUrl(url)) return workday(url);
  throw new UnsupportedAtsError(`No fetcher for ${ats ?? 'unknown ATS'}: ${url}`);
}
