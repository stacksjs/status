CREATE TABLE IF NOT EXISTS "sso_identities" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "provider" TEXT,
  "subject" TEXT,
  "email" TEXT,
  "user_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
