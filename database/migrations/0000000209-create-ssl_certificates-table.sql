CREATE TABLE IF NOT EXISTS "ssl_certificates" (
  "id" BIGSERIAL PRIMARY KEY,
  "issuer" varchar(255),
  "subject" varchar(255),
  "valid_from" varchar(255),
  "expires_at" varchar(255),
  "fingerprint" varchar(255),
  "last_checked_at" varchar(255),
  "monitor_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
