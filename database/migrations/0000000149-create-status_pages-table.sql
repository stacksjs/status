CREATE TABLE IF NOT EXISTS "status_pages" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "slug" TEXT,
  "title" TEXT,
  "custom_domain" TEXT,
  "branding" TEXT,
  "is_public" INTEGER default 1,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
