CREATE TABLE IF NOT EXISTS "maintenance_window_monitors" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "maintenance_window_id" INTEGER REFERENCES "maintenance_windows"("id"),
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
