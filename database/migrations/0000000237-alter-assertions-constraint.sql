ALTER TABLE "assertions" ADD CONSTRAINT "assertions_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
