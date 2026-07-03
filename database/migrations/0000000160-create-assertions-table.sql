CREATE TABLE IF NOT EXISTS "assertions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "target" TEXT CHECK ("target" IN ('status_code', 'header', 'body', 'response_time')),
  "property" TEXT,
  "compare" TEXT CHECK ("compare" IN ('eq', 'not_eq', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'empty', 'not_empty')),
  "expected" TEXT,
  "sort_order" INTEGER default 0,
  "monitor_id" INTEGER REFERENCES "monitors"("id"),
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
