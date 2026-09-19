-- Explicit public curation allowlist for the Safari presentation projection.
-- Records are public only when an operator adds them here; no generic anonymous record access.
-- No foreign key: records uses a composite primary key, and orphan allowlist rows are harmless
-- because the public projection joins against records.
CREATE TABLE safari_public_records (
  record_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE INDEX safari_public_records_by_record ON safari_public_records(record_id);
