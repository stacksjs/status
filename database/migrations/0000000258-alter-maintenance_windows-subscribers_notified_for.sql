-- Tracks which upcoming occurrence subscribers were last emailed about, so the
-- scheduled advance-notice job (NotifyUpcomingMaintenance) announces each
-- occurrence exactly once. Stores the occurrence start as an ISO string; null
-- means never announced. Hand-written ALTER, same rationale as 0000000255-257.
ALTER TABLE "maintenance_windows" ADD COLUMN "subscribers_notified_for" TEXT;
