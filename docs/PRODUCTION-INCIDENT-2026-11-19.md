# Production HTTP 500s and partial release — November 19, 2026

Status: **open, pending operator approval and a verified production release**.

## Evidence and root cause

Release [44100273726](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/44100273726)
published primary revision `0b1e53515048c5b289fddcebddaf2bf685cfbf75`, Cloudflare
version `a0de66e6-3d2d-463e-88b2-e75644294d7f`. Every primary verification attempt
failed the unknown human session check with HTTP 500. Several attempts also
failed application authentication and both public projections. Analytics was
correctly skipped and remains at `ea305611cb71508fccae0ba7042284e52878f80e`.
Drift run [44514974344](https://github.com/hmarquardt/aismallbizguru-cflab/actions/runs/44514974344)
reported the resulting revision split.

The same failure pattern was reproduced on November 19 using the unchanged
production verifier. All ten Analytics checks passed, including the CFLAB auth
service binding and all collector routes. Primary health, revision and checks
that reject credentials without accessing D1 passed. An unknown human session
returned 401 when tested separately outside the failing sequence.

Live `wrangler tail cflab --format json` correlated a Safari request taking
6,608 ms with the subsequent unknown-session 500 (CF-Ray
`a5d2578edd00ecd4-CMH`). The deployed error handler caught the exception and
logged only `internal_error`, so there was no uncaught runtime stack. A concurrent
read-only primary D1 schema query failed with the explicit error:

```text
D1 DB is overloaded. Too many resources consumed within a 10 second window. [code: 7429]
```

Cloudflare [documents this error](https://developers.cloudflare.com/d1/observability/debug-d1/)
as resource-window throttling from expensive queries. Reads of the deployed
version confirmed the intended DB, ANALYTICS, BTC_SIGNALS, FILES and auth bindings;
the release preflight also verified all three database identities. Primary D1
schema inspection showed the expected tables and indexes. No missing credentials
or resource configuration were found.

`EXPLAIN QUERY PLAN` on the existing Safari image query showed `CO-ROUTINE page`,
`USE TEMP B-TREE FOR ORDER BY`, then an outer file search and `SCAN page`. SQLite
can restart that co-routine for each matching file, repeatedly scanning and JSON
sorting the observations despite `limit=1`. The database contained 1,784 active
observations with 14,243,624 JSON bytes. This expensive shared-database read
exhausted the D1 resource window, causing unrelated session and projection reads
to fail. Retrying the verifier repeated the expensive query.

A read-only counter query using `WITH page AS MATERIALIZED` against the same
production database showed `MATERIALIZE page`, took 103.2535 ms, read 5,474 rows,
and wrote zero rows. The SQL evaluates the page once before joining files.
This is a direct database comparison, **not** a deployed application fix or a
claim of production recovery. No production writes or configuration changes
were made during investigation.

## Repair and validation

* Materialize the existing Safari image page once, preserving its ordering,
  pagination, file visibility and bound-parameter limits. No migration is needed.
* Exercise the real query against ephemeral D1 with observations and many files.
  Compare equal results and actual rows read against the previous co-routine
  query; require at least a fivefold reduction, independent of machine timing.
* Keep overload responses as HTTP 500 with a generic body, but log a fixed
  `dependency: d1, reason: overloaded` classification without SQL or secrets.
* Include safe CF-Ray identifiers in failed HTTP probes for log correlation.
* Verify both Workers together and run drift verification in the existing release
  job. Include both outcomes in the release verdict and preserve diagnostic logs.
  Run drift diagnostics after partial releases without bypassing failed gates.
* Remove only the standalone drift cron; retain manual dispatch. Backup schedules,
  resource bindings, credentials, data and all release gates remain protected.

Local validation passed: `npm ci`; `npm run check` (709 tests, including 462
Workers tests, plus typechecking and vendored-asset verification); all three local
migration commands; `npm run build`; and `npm run build:analytics`. Both builds
were dry runs. PR validation and the eventual production release run are recorded
in the release handoff. These local checks do not establish production recovery.

## Approved recovery procedure

The repository variable `CLOUDFLARE_DEPLOY_ENABLED` was read as `true` and left
unchanged. Publishing this fix on `main` would therefore initiate a production
release. **Operator approval is required before advancing `main` or dispatching
a production release.** Prepare and validate the fix on its branch first.

After approval, publish the approved commit to `main` and let the existing
`validate and deploy` workflow validate, check/apply approved pending migrations,
deploy primary, verify primary, deploy Analytics, verify Analytics, verify the
complete release and verify drift. Do not retry the old failed run, deploy one
Worker separately, change the gate or bypass a failure. Inspect the actual deploy
job outcomes and diagnostic artifact if anything fails.

Then, from a fetched full checkout, run:

```sh
node scripts/verify-production.mjs --service all --revision <approved-sha>
node scripts/verify-drift.mjs
```

Record the approved SHA, release run, both live revisions and both command results.
Close this incident only when both commands pass and both Workers report that SHA.
The removed cron takes effect when the workflow change reaches `main`.
