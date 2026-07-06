ALTER TABLE "port_scan_results" ADD CONSTRAINT "port_scan_results_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
