CREATE TABLE IF NOT EXISTS "monitors" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "name" TEXT,
  "url" TEXT,
  "type" TEXT CHECK ("type" IN ('uptime', 'ssl', 'broken_links', 'performance', 'lighthouse', 'domain', 'dns', 'health', 'cron', 'ping', 'tcp_port', 'port_scan', 'dns_blocklist', 'ai_check')),
  "enabled" INTEGER default 1,
  "check_interval_seconds" INTEGER default 60,
  "config" TEXT,
  "status" TEXT CHECK ("status" IN ('up', 'down', 'degraded', 'paused', 'unknown')) default 'unknown',
  "last_checked_at" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
