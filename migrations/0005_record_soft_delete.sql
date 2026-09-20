-- Archive-style deletion for captured wildlife data. Records are soft-deleted so
-- Field Recorder deletes remain recoverable; reads exclude archived rows.
ALTER TABLE records ADD COLUMN deleted_at TEXT;
CREATE INDEX records_by_deleted ON records(app_id, resource, deleted_at, id);
