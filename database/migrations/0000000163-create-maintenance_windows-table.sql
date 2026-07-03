CREATE TABLE IF NOT EXISTS "maintenance_windows" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "title" TEXT,
  "description" TEXT,
  "starts_at" TEXT,
  "ends_at" TEXT,
  "status" TEXT CHECK ("status" IN ('scheduled', 'active', 'completed', 'cancelled')) default 'scheduled',
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
