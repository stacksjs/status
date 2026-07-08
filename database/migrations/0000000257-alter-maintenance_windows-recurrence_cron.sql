-- Optional recurrence for maintenance windows (docs/operate/maintenance.md:
-- "schedule recurring windows for regular work like weekly reboots"). A 5-field
-- cron expression drives the start of each occurrence; the window's
-- starts_at/ends_at define each occurrence's duration. Null = one-off.
-- Hand-written ALTER, same dual-dialect-drift rationale as 0000000255/256.
ALTER TABLE "maintenance_windows" ADD COLUMN "recurrence_cron" TEXT;
