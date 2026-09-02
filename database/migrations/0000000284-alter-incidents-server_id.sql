-- Box-level incidents (threshold breach, missed push) belong to a Server,
-- not to one of the monitors that happen to sit on it, so a hot box is one
-- incident and one notification fan-out. For those rows server_id is set
-- and monitor_id is NULL (monitor_id has been nullable since
-- 0000000215). Same hand-written-ALTER rationale as 0000000283.
ALTER TABLE "incidents" ADD COLUMN "server_id" INTEGER;
CREATE INDEX IF NOT EXISTS "incidents_server_id_index" ON "incidents" ("server_id");
