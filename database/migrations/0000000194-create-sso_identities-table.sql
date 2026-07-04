CREATE TABLE IF NOT EXISTS "sso_identities" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "user_id" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "email" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sso_identities_provider_subject_unique ON sso_identities(provider, subject);
CREATE INDEX IF NOT EXISTS sso_identities_user_id_index ON sso_identities(user_id);
