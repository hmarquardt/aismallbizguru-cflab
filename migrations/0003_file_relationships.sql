-- Preserve legacy record/file relationships for migrated data. Additive and nullable.
ALTER TABLE files ADD COLUMN resource TEXT;
ALTER TABLE files ADD COLUMN record_id TEXT;
CREATE INDEX files_by_record ON files(app_id, resource, record_id);
