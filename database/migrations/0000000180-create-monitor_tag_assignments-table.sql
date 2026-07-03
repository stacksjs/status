CREATE TABLE IF NOT EXISTS "monitor_tag_assignments" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "monitor_tag_id" INTEGER REFERENCES "monitor_tags"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
