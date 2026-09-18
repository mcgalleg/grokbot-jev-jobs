# Apply efficiency learnings

Operational notes from production Apply. No secrets.

## 2026-09-18 — duplicate runners and callback truth

Socure: a knock-out set the attempt to `blocked` at ~1:46pm MT. A parallel
runner on the same posting kept filling and submitted. Confirmation email
arrived at 1:51pm MT. The pointer stayed `blocked` because `settleAttempt` only
updated rows still in `applying`, so an `applied` callback could not correct
the race. A Neon direct write was used once as an emergency.

**Fix (this repo + Rudy):**

- One owner for a posting. Do not run two Apply browsers against the same URL.
- Re-check the knock-out immediately before Submit.
- Abort Submit if the attempt is already terminal (`GET /api/webhooks/rudy-apply`
  with `attemptId` or `jobUrl`, same Bearer `RUDY_CALLBACK_SECRET` as POST).
- A later `applied` callback for the same `attemptId`+`jobUrl` overwrites
  `blocked` / `failed` / `skipped`. Those statuses never overwrite `applied`.

**Callback 401:** the box secret must match Vercel `RUDY_CALLBACK_SECRET`. Keep
them synced. A Neon direct write is emergency-only, not the recovery path.

**Wall clock:** browser fill dominates. Jev stays sparse — knock-out scan
before the heavy fill, then outcome classification. Not a speed-up.

**Resume-only:** every production apply uses

`/home/mike/Projects/grokbot-jev-jobs/output/mike-gallegos-cv.pdf`

No cover-letter upload.
