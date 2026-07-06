CREATE TABLE IF NOT EXISTS "domain_registrations" (
  "id" BIGSERIAL PRIMARY KEY,
  "registrar" varchar(255),
  "registered_at" varchar(255),
  "expires_at" varchar(255),
  "last_checked_at" varchar(255),
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
