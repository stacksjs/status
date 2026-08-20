CREATE TABLE IF NOT EXISTS "status_page_monitors" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "display_name" TEXT,
  "display_order" INTEGER default 0,
  "status_page_id" INTEGER,
  "monitor_id" INTEGER,
  "status_page_component_group_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
