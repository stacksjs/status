CREATE TABLE IF NOT EXISTS "domain_registrations" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "registrar" TEXT,
  "registered_at" TEXT,
  "expires_at" TEXT,
  "last_checked_at" TEXT,
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
