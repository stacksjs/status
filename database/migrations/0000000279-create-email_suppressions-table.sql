-- Suppression list for outbound email (bounces, complaints, unsubscribes).
--
-- @stacksjs/email writes here via insertInto("email_suppressions").values({
--   email, type, reason, created_at
-- }) and reads back with selectAll(), so the columns below mirror that insert
-- exactly. Without the table the package degrades rather than throwing --
-- "suppression checks accepted but NOT enforced" -- which means a missing
-- table silently turns the suppression list off instead of failing loudly.
--
-- Addresses are stored already canonicalised by the caller; the unique index
-- is what makes re-suppressing the same address idempotent.
CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "email" TEXT NOT NULL,
  "type" TEXT,
  "reason" TEXT,
  "created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_email_unique" ON "email_suppressions" ("email");
