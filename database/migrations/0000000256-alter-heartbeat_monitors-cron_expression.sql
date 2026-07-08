-- Optional cron expression cadence for heartbeat monitors
-- (docs/monitors/cron-heartbeats.md: "paste a cron expression"). When set, the
-- next-expected-ping deadline is computed from the schedule instead of
-- expected_interval_seconds. Hand-written ALTER, same rationale as 0000000255.
ALTER TABLE "heartbeat_monitors" ADD COLUMN "cron_expression" TEXT;
