ALTER TABLE "status_report_monitors" ADD CONSTRAINT "status_report_monitors_status_report_id_fk" FOREIGN KEY ("status_report_id") REFERENCES "status_reports"("id");
ALTER TABLE "status_report_monitors" ADD CONSTRAINT "status_report_monitors_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
