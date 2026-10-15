-- Transactional email: distinct account-setup invitations and password recovery.
-- Additive only. Existing reset-token rows keep the single-use 'recovery'
-- purpose; the new users columns are nullable so existing accounts (including
-- accounts created before this migration) keep their roles and memberships.
ALTER TABLE password_reset_tokens ADD COLUMN purpose TEXT NOT NULL DEFAULT 'recovery' CHECK (purpose IN ('recovery', 'invite'));
CREATE INDEX reset_tokens_by_purpose ON password_reset_tokens(purpose, user_id);

-- Invitation delivery state, surfaced in the admin UI. `invited_at` is the most
-- recent attempt; `invite_status` records whether that attempt was delivered.
ALTER TABLE users ADD COLUMN invited_at TEXT;
ALTER TABLE users ADD COLUMN invite_status TEXT CHECK (invite_status IN ('sent', 'failed'));
ALTER TABLE users ADD COLUMN invite_expires_at TEXT;
ALTER TABLE users ADD COLUMN invite_error TEXT;
