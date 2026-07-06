CREATE TABLE IF NOT EXISTS "status_page_subscribers" (
  "id" BIGSERIAL PRIMARY KEY,
  "email" varchar(255),
  "unsubscribe_token" varchar(255),
  "confirmed_at" varchar(255),
  "status_page_id" bigint,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
