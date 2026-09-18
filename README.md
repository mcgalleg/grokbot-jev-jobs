# Jev Job Search

Scores public job postings against your resume using
[TypeSafe AI's Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway/modalities/evaluation).

Jev is an evaluation model, not a text model. You give it a state and a set of
typed questions; it returns choices, scores and boolean probabilities with
calibrated confidence, in roughly half a second, for $0.042 per million input
tokens with output tokens free. That makes it cheap enough to read every
plausible posting every day.

## The funnel

Each stage is cheaper than the one after it, so expensive work only touches
postings that survived the cheap work.

| Stage | What runs | Input | Typical survival |
|---|---|---|---|
| 0. Ingest | deterministic code | ~1.46M postings from the feed | 5.6% |
| 1. Triage | jev, title only | title, company, location | 10.3% |
| 2. Describe | ATS APIs | survivors only | 65% (rest expired or unsupported) |
| 3. Score | jev, full text | resume + targets + description | all |

**Stage 0** applies only hard facts: location, and the recruiter flag. Anything
that is a judgement call is left to jev, because a title regex misses "Member of
Technical Staff, Customer Engineering" and catches "Product Manager, Payroll".

Seniority is deliberately *not* screened here. The feed's `skill_level` tag is a
keyword guess, and on a 250-posting sample of rows it rejected, jev kept none —
but it was throwing away ~7,100 postings feed-wide on a judgement it is not
qualified to make. `pnpm ingest --drop-junior-levels` opts back in.

**Stage 3** asks ten atomic questions and combines them in code
(`lib/jev/score.ts`), rather than asking one vague "is this a good fit". The
weights stay inspectable and tunable without re-prompting.

## Data source

Job data comes from
[Feashliaa/job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator),
which publishes ~1M postings daily as gzipped chunks on GitHub Pages. **We read
it as a feed; we never run their scraper.** Their data repo is force-pushed on
every run with no history, so this project's database is the only durable
record of what has been seen and scored.

The feed carries no job descriptions. Those are fetched from the applicant
tracking system for postings that survive triage.

| Platform | Strategy | Requests | Concurrency |
|---|---|---|---|
| Greenhouse | whole board, cached per company | 1 per company | 8 |
| Lever | whole board, cached per company | 1 per company | 8 |
| Ashby | whole board, cached per company | 1 per company | 4 |
| Workday | per posting; no board endpoint carries text | 1 per posting | 3 |
| BambooHR, iCIMS, Paylocity | not wired up | — | — |

Postings on a platform with no fetcher are moved to an `unsupported` stage rather
than left pending, so they are not re-read every night. They are terminal until
someone writes the fetcher: currently 315 of them, Paylocity and BambooHR.

Two platform quirks are handled rather than papered over. Greenhouse customers
who white-label the board onto their own domain drop the board token from the
URL and keep the id in `?gh_jid=`; the feed's company field supplies the token.
Workday answers **403** both when it is throttling and when a requisition has
been withdrawn, so a 403 is retried and only then classified as expired.

Postings vanish constantly. The feed keeps jobs for 30 days, so roughly a third
of fetches find the posting already pulled. That is counted as `expired`, not as
an error — and so is a 404 on a *board* endpoint, which means the company's board
is gone or its slug never matched. Both are dead ends, not faults, and counting
them as errors would bury the real ones in the nightly summary.

## Setup

```bash
pnpm install
vercel link
vercel env pull .env.local      # DATABASE_URL, AI_GATEWAY_API_KEY, CRON_SECRET
pnpm check:jev                  # one live call: confirms the key, prints latency + cost
```

Secrets live only in Vercel project settings and in `.env.local`, which is
git-ignored. `vercel env pull` brings down the Neon URL, `CRON_SECRET` and the
profile, so a fresh clone with access to the project is ready to run.

### Two ways to reach the AI Gateway, two budgets

Worth knowing, because it is easy to think one budget covers everything:

| Where | Authenticates with | Budget |
|---|---|---|
| Local CLI | `AI_GATEWAY_API_KEY` from `.env.local` | `api-key jev-job-search-poc`, $25/mo |
| The deployment | `VERCEL_OIDC_TOKEN`, injected automatically | `project jev-job-search`, $25/mo |

`AI_GATEWAY_API_KEY` is deliberately **not** in the Vercel project environment —
a deployed function does not need it, and a long-lived key in the environment is
worse than an OIDC token that Vercel mints per deployment. The consequence is that
the api-key budget does not cap the nightly run; the project budget is what does.
Both are set, and `vercel ai-gateway budgets ls` shows them side by side.

A one-off `scripts/migrate-to-neon.mts` and the SQLite layer under `lib/db/index.ts`
remain from the move off local storage. Nothing in the running system uses them —
delete both, and `data/`, once you no longer want the local copy as a backup.

### Your profile

`profile/` and `output/` are **git-ignored on purpose** — they hold a CV, cover
letters and a salary floor, and git history is hard to scrub.

| File | Env var | What it is |
|---|---|---|
| `profile/summary.md` | `PROFILE_SUMMARY` | ~200 words on the candidate, for the cheap title pass |
| `profile/resume.md` | `PROFILE_RESUME` | the full CV as markdown, for deep scoring |
| `profile/targets.md` | `PROFILE_TARGETS` | what a good role looks like, incl. any salary floor |

`lib/profile.ts` reads the env var first and falls back to the file. Locally you
edit the markdown; the deployment reads the env vars, because a build from GitHub
never sees git-ignored files. `profile/` is in `.vercelignore` so that a CLI deploy
and a git deploy behave identically — otherwise only one of the two paths would
ever be exercised.

A fresh clone therefore does **not** need the markdown files: `vercel env pull`
brings the profile down from the project, and the pipeline runs off the env vars.
Write the files only if you want to edit a profile, or if you have no access to
the Vercel project.

**After editing any of the three, push them up:**

```bash
pnpm profile:push        # copies the files into the Vercel project env
vercel deploy --prod     # or push to the connected branch
```

Forgetting this means the nightly run keeps scoring against the previous profile,
which is silent. `/api/cron/probe` reports where each part came from
(`env` / `disk` / `missing`) so the state is at least observable.

## Running it

```bash
pnpm dev                               # dashboard on localhost:3000
pnpm pipeline --limit 200              # run the whole funnel by hand
vercel crons run /api/cron/pipeline    # or trigger the real scheduled run now
```

Or a stage at a time:

```bash
pnpm ingest   --chunks 4               # feed -> postgres, applying the stage 0 screen
pnpm ingest   --since 2026-09-17T00:00:00Z   # or only what is new
pnpm triage   --limit 500              # jev on titles
pnpm triage   --ats Workday --limit 500 # or target one platform
pnpm describe --limit 500              # ATS descriptions
pnpm score    --limit 200              # jev on resume vs description
pnpm report   --top 20                 # ranked list in the terminal
```

All of these hit the same Neon database the deployed dashboard reads, and run the
same `lib/stages` code the cron does — there is no separate local database and
nothing to sync.

`pnpm describe` is not called `pnpm fetch` because `pnpm fetch` is a built-in
pnpm command. `pnpm publish` and `pnpm deploy` are taken for the same reason.

Every stage writes a row to the `runs` table with token counts and cost, so spend
is auditable without opening the Vercel dashboard. `pnpm report` reads that table;
it does not add to it.

Two diagnostics, neither of which touches pipeline state:

```bash
pnpm check:jev    # one live gateway call: confirms the key, prints latency and cost
pnpm check:ats    # fetches a few real postings from each wired ATS, plus URL parsing
```

## Tuning it

Three files control quality, in descending order of leverage.

1. **`profile/targets.md`** — what a good role looks like. This is the single
   biggest lever. Jev reads it as the definition of a match.
2. **`lib/jev/score.ts`** — the ten questions and the composite weights.
3. **`profile/summary.md`** — the compact profile used for title triage, kept
   short so the cheap pass stays cheap.

## Where it stands

The first full pass, September 2026:

| | |
|---|---|
| Scanned from the feed | 1,461,580 |
| Kept by the stage 0 screen | 81,329 (5.6%) |
| Kept by jev triage | 8,362 (10.3%) |
| Descriptions fetched | 5,442 |
| Expired before we could read them | 2,508 |
| On an ATS with no fetcher | 315 |
| Scored | 5,442, mean 2.48, max 7.91 |
| Scoring 6.0 or above | **160** |
| Total jev spend | $2.91 |

## Measuring whether it works

The dashboard's thumbs up and down write to the `labels` table. That labelled
set is the point of the exercise: once a few dozen verdicts are in, compare them
against the ranking. If jev's top twenty and your top twenty disagree, the fix
is almost always the wording in `targets.md`, not the weights.

## Deployment

Everything runs on Vercel. Nothing needs to be run by hand.

```
Vercel Cron (15:00 UTC daily)
   -> /api/cron/pipeline   maxDuration 800s, guarded by CRON_SECRET
        ingest   differential: only postings first seen since the last run
        triage   jev on titles
        describe ATS descriptions
        score    jev on resume vs description
   -> Neon Postgres <- the dashboard reads the same database
```

### Why a daily run fits in one function

The backfill was 81k postings and took about an hour. A *daily* run is not that,
and the difference is the whole design:

| | |
|---|---|
| Full feed scan (59 chunks, 73MB gzipped) | **13s** on Vercel, 39s locally — measured |
| A whole cron pass with nothing new to do | **12.8–14.3s** — measured |
| Postings with `first_seen` in the last 24h | ~31,000 feed-wide — measured |
| Surviving the stage 0 location screen | ~1,750/day — projected |
| Surviving triage, so needing a description and a score | ~190/day — projected |
| Wall clock on a normal day | ~5 min against an 800s ceiling — projected |
| Cost | ~$0.15/day — projected |

The measured rows are from real runs; the projected ones scale the first full pass
by the observed daily intake and have not yet been seen on a live day, because the
upstream feed had not refreshed while this was being built.

800s is generally available on Pro. Every stage gets a share of the remaining
budget and stops cleanly when it runs out; because each one selects only
unprocessed rows and commits per row, stopping early costs time, never work, and
the next run continues where it left off.

### The differential

The feed republishes all ~1.4M postings every day. `first_seen` is what makes the
daily run cheap: the ingest skips anything first seen before the last successful
run, less an hour of slack for clock skew. That turns ~81,000 upserts into
~1,750.

The window is a cron concern, not a CLI one. `GET /api/cron/pipeline?full=1`
overrides it for a recovery run; from the CLI, `pnpm ingest` scans everything by
default and `--since <iso>` narrows it.

Cron delivery is best effort and can miss or duplicate a run, so every stage is
idempotent and reconciliation-based: the window is always "since the last
successful ingest", never "since yesterday", so a missed night is picked up the
following one.

### Three things that were verified rather than assumed

- **ATS fetching works from a datacenter IP.** Workday 403s aggressively and was
  the main risk to running this on Vercel at all. Twelve live postings across
  Greenhouse, Lever, Ashby and Workday returned identical byte counts from
  `iad1` and from a residential connection, and faster.
- **Vercel Cron reaches the function past Deployment Protection.** This one
  matters because the failure is silent: protection answers an external request
  with a 302, and cron treats a 3xx as a completed invocation, so a protected
  cron path would appear to succeed every night while doing nothing. Cron's own
  invocations are exempt and arrive carrying the `CRON_SECRET` bearer token.
  `/api/cron/probe` runs nightly and records a row in `runs` purely so that this
  stays observable if the setting ever changes.
- **The profile reaches the function.** `lib/profile.ts` is read inside triage and
  score, so a deployment without it fails on the first posting it judges and not
  a moment earlier — which is exactly how it got shipped once. Confirmed on a
  build made from GitHub, with `profile/` absent from both the repo and the
  bundle: the probe reports all three parts sourced from `env`, and a live triage
  of three postings returned zero errors.

### Deploying

The Vercel project is connected to `mcgalleg/jev-job-search` (private), production
branch `master`. Pushing to `master` builds and promotes automatically; branches
and pull requests get preview deployments.

```bash
git push                 # code changes
pnpm profile:push        # profile changes — env vars, not files (see "Your profile")
vercel deploy --prod     # still works, for a deploy without a commit
```

The two are not interchangeable in one respect: a code change needs a push, a
profile change needs `profile:push` *and* a rebuild, because the profile travels
as environment variables rather than as files in the repo.

### Access

**Vercel Authentication** on `all` deployments: the dashboard is tied to your
Vercel account, with no auth code in the app and no shared password. External
requests get a 302, including to the cron path. `.vercelignore` keeps `output/`,
`profile/` and `data/` out of the build context.

## Stack

Next.js 16 App Router, React 19, Tailwind 4, shadcn/ui (Base UI),
AI SDK 7 `experimental_evaluate`, Neon Postgres via `@neondatabase/serverless`.

One database, one schema (`lib/db/pg-schema.ts`). The four stages live in
`lib/stages/` and are called by both the cron route and the CLI, so the
scheduled run and a hand-run cannot drift apart.

## Known limits

- `experimental_evaluate` is experimental and may change in a patch release.
  The `ai` version is pinned at 7.0.105.
- Jev rate limits are undocumented. Concurrency 8 has been tested; higher is untested.
- Workday is the tightest ATS limiter and runs at concurrency 3, about 2 postings
  per second. It is the only platform that costs one request per posting.
- Job descriptions are untrusted text. Jev cannot generate, so the worst case is
  a skewed score, but every instruction still says to treat the posting as
  evidence rather than instructions.
- The upstream feed is one person's hobby project. `pnpm ingest` warns if the
  manifest is more than three days stale.
- The aggregator's company datasets are CC BY-NC. Personal use is fine.
- Cron delivery is best effort: Vercel may skip or repeat an invocation and does
  not retry a failed one. The stages are idempotent and the ingest window is
  anchored to the last successful run, so a missed night self-heals — but a run
  that fails is only visible in the `runs` table and the Vercel logs.
