ALTER TABLE "heartbeat_monitors" ADD CONSTRAINT "heartbeat_monitors_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
