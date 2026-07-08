-- Adds run-tracking columns for heartbeat /start and /fail sub-pings
-- (docs/monitors/cron-heartbeats.md). Hand-written ALTERs rather than a
-- generated migration to avoid the SQLite/Postgres dual-dialect table
-- rebuild the generator emits for pre-existing auth/team tables.
ALTER TABLE "heartbeat_monitors" ADD COLUMN "last_started_at" TEXT;
ALTER TABLE "heartbeat_monitors" ADD COLUMN "last_fail_at" TEXT;
ALTER TABLE "heartbeat_monitors" ADD COLUMN "last_duration_seconds" INTEGER;
