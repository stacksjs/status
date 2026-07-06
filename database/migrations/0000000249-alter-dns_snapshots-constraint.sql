ALTER TABLE "dns_snapshots" ADD CONSTRAINT "dns_snapshots_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
