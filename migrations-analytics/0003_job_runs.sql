CREATE TABLE IF NOT EXISTS console_job_runs (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS console_job_runs_by_job ON console_job_runs(job, started_at);
