ALTER TABLE "check_results" ADD CONSTRAINT "check_results_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
