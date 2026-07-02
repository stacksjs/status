CREATE TABLE IF NOT EXISTS "port_scan_results" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "open_ports" TEXT,
  "expected_ports" TEXT,
  "checked_at" TEXT,
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
