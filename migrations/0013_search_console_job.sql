-- Observability row for the Search Console collector that runs inside the
-- Analytics Worker's existing hourly cron. This is display metadata only: it
-- never drives a schedule. Execution history is read from
-- `cflab-analytics.console_job_runs` (job id `analytics-search-console`), the
-- same mechanism the analytics rollup/retention job already uses.
INSERT OR IGNORE INTO console_jobs
  (id, service_id, name, schedule, schedule_timezone, description, history_source, history_key, stale_after_minutes, active)
VALUES
  ('analytics-search-console', 'cflab-analytics', 'Search Console collection', '17 * * * *', 'UTC',
   'Daily Google Search Console collection for the six verified properties, with recent-day reconciliation and bounded historical backfill. Runs inside the analytics hourly cron.', 'analytics-maintenance', NULL, 1800, 1);
