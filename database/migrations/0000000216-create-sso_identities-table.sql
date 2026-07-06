CREATE TABLE IF NOT EXISTS "sso_identities" (
  "id" BIGSERIAL PRIMARY KEY,
  "provider" varchar(255),
  "subject" varchar(255),
  "email" varchar(255),
  "user_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
