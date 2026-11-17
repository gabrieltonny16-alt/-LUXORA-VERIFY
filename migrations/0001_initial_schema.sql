-- LUXORA VERIFY initial schema.
-- D1/SQLite. Apply only after a D1 database has been explicitly created.

PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  allowed_channels TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE project_api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE INDEX idx_project_api_keys_project
  ON project_api_keys(project_id, revoked_at);

CREATE TABLE otp_challenges (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  purpose TEXT NOT NULL,
  destination_fingerprint TEXT NOT NULL,
  destination_ciphertext TEXT NOT NULL,
  code_hmac TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resend_after INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  consumed_at INTEGER,
  delivery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_status IN ('pending', 'sent', 'failed', 'unknown'))
) STRICT;

CREATE INDEX idx_otp_challenges_project_created
  ON otp_challenges(project_id, created_at);

CREATE INDEX idx_otp_challenges_destination
  ON otp_challenges(project_id, destination_fingerprint, created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  challenge_id TEXT REFERENCES otp_challenges(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
) STRICT;

CREATE INDEX idx_audit_events_project_time
  ON audit_events(project_id, occurred_at);
