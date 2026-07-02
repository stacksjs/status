CREATE TABLE IF NOT EXISTS "ssl_certificates" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "issuer" TEXT,
  "subject" TEXT,
  "valid_from" TEXT,
  "expires_at" TEXT,
  "fingerprint" TEXT,
  "last_checked_at" TEXT,
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
