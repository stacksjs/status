CREATE TABLE IF NOT EXISTS "status_page_subscribers" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "email" TEXT,
  "unsubscribe_token" TEXT,
  "confirmed_at" TEXT,
  "status_page_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
