CREATE TABLE IF NOT EXISTS "lighthouse_reports" (
  "id" BIGSERIAL PRIMARY KEY,
  "performance_score" integer,
  "accessibility_score" integer,
  "seo_score" integer,
  "best_practices_score" integer,
  "report_json" varchar(255),
  "checked_at" varchar(255),
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
