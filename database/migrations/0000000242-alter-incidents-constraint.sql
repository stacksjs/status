ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
