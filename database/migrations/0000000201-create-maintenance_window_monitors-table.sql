CREATE TABLE IF NOT EXISTS "maintenance_window_monitors" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "maintenance_window_id" INTEGER,
  "monitor_id" INTEGER,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
