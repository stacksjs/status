CREATE TABLE IF NOT EXISTS "team_members" (
  "id" BIGSERIAL PRIMARY KEY,
  "team_id" integer,
  "user_id" integer,
  "invited_email" varchar(255),
  "role" role_type default 'member',
  "status" status_type default 'pending',
  "invited_at" varchar(255),
  "joined_at" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp,
  "uuid" varchar(255)
);
