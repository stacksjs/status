CREATE TABLE IF NOT EXISTS "team_members" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "user_id" INTEGER,
  "invited_email" TEXT,
  "role" TEXT default 'member',
  "status" TEXT default 'pending',
  "invited_at" TEXT,
  "joined_at" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
