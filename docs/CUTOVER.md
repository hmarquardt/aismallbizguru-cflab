# LabBox hostname cutover and VM retirement (prepared, not executed)

This plan moves `lab.aismallbizguru.com` from the legacy VM to the existing `cflab` Worker. It reuses the existing Worker, operational D1, `cflab-analytics` D1, and `cflab-files` R2. It is **not executed** in this pass.

## Current state

| Consumer | Backend | Notes |
| --- | --- | --- |
| Wildlife Safari | CFLab public projection | no credential |
| Wildlife Pattern Lab | CFLab human session | private reads |
| Wildlife Field Recorder | CFLab human session | reads/writes/files |
| Top Hat Ferals | CFLab public projection + account writes | live at `tophatferals.com` |
| Analytics collector | CFLab `/api/analytics/collect` | legacy contract preserved; 72 pages unchanged |
| Analytics dashboard | CFLab admin session | migrated |

Runtime `lab.aismallbizguru.com` references after this pass:
- **Intentional**: 72 Junk Drawer pages plus Top Hat Ferals, Pattern Lab, Safari, and Field Recorder analytics collector tags (`/api/analytics/collect`), which CFLab serves at the same path.
- **Guard-only**: client code that detects and migrates a stored legacy API base.
- **Documentation/archive**: legacy repo docs and examples; not runtime.
- No remaining runtime calls to LabBox wildlife, files, or record APIs.

## Cutover steps

1. **Final delta/reconciliation**: rerun `scripts/migrate/export-labbox.ts` (GET-only) and `reconcile.ts --compare` for observations, trips, files, and Top Hat Ferals; import any delta. Confirm D1 counts (1,092 observations, 51 trips, 10 sightings, 1,151 files) and R2 hash verification.
2. **Analytics decision**: confirm historical analytics is either imported or explicitly deferred. New collection already targets CFLab.
3. **DNS/route change**: add `lab.aismallbizguru.com` as a Custom Domain on the existing `cflab` Worker (`routes` entry) after removing the legacy origin's DNS/route. Verify the zone/account and that no wildcard intercepts the hostname. Do not create a second Worker or database.
4. **Old-URL smoke tests**: `GET https://lab.aismallbizguru.com/api/health` must return `{"status":"ok","service":"cflab"}`; authenticated clients use the same API paths they already use on `cflab`.
5. **Analytics collector verification**: send a controlled pageview/event from an allowed origin to `https://lab.aismallbizguru.com/api/analytics/collect`; confirm storage and dashboard visibility; delete the test rows.
6. **Safari verification**: load the public page; confirm reads, photos, no credential.
7. **Pattern Lab verification**: log in, pull complete collections, confirm counts and cache behavior.
8. **Field Recorder verification**: log in, read existing data, create a labeled test record with a photo, verify D1/R2, archive it, confirm offline queue behavior.
9. **Top Hat Ferals verification**: load `tophatferals.com`, confirm sightings/photos and account sign-in.
10. **Dashboard verification**: sign in with a CFLab admin account; compare summary/timeseries/pages/referrers/recent against expectations for the same range.
11. **Observation period**: keep the VM running and DNS reversible for an agreed window (suggest 1–2 weeks) while monitoring for missed consumers.
12. **Final archival backup**: run a final LabBox backup (SQLite + MinIO + config) to the encrypted Restic repository, or export equivalent artifacts; verify the restore procedure once.
13. **Rollback**: see below.

## Rollback procedure

- Revert the DNS/route change so `lab.aismallbizguru.com` points at the legacy origin again (the VM remains running until retirement).
- Client configuration: revert the affected client commits if a client-side issue is found; CFLab data remains intact.
- If new CFLab-only writes occurred during the window, export them before rollback and reconcile manually; never blindly push CFLab records back into LabBox.
- Do not resurrect the revoked/exposed Safari token.

## VM retirement checklist

**Must preserve before destruction**
- Final SQLite database backup (or verified archive copy).
- MinIO object inventory and any objects not represented in `cflab-files` (compare counts/checksums).
- `apps.yaml` app configuration and proxy-source definitions.
- `docker-compose.yml`, `Caddyfile`, systemd unit, and cron/systemd timers.
- Environment/secrets inventory (names and purpose only; never commit values).
- The encrypted Restic repository in `labs-smallbizguru-backups` (leave untouched).
- DNS/origin references and the zone's current records for `lab.`.

**Nice to preserve**
- Application logs if they contain unique operational history.
- Backup scripts and deployment docs.
- SSH authorized-keys inventory for audit.

**Safe to discard**
- Container images and caches, transient build artifacts, OS packages, and anything already reproduced in CFLab with verified checksums.

Retirement is complete only when every consumer is confirmed on CFLab, the observation window has passed with no rollback, the final backup is verified restorable, and the hostname no longer resolves to the VM.
