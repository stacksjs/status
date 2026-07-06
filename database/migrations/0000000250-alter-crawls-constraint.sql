ALTER TABLE "crawls" ADD CONSTRAINT "crawls_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
