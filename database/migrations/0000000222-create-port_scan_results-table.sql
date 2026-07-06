CREATE TABLE IF NOT EXISTS "port_scan_results" (
  "id" BIGSERIAL PRIMARY KEY,
  "open_ports" varchar(255),
  "expected_ports" varchar(255),
  "checked_at" varchar(255),
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
