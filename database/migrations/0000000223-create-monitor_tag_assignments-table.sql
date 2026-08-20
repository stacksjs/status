CREATE TABLE IF NOT EXISTS "monitor_tag_assignments" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "monitor_id" INTEGER,
  "monitor_tag_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
