ALTER TABLE "status_report_updates" ADD CONSTRAINT "status_report_updates_status_report_id_fk" FOREIGN KEY ("status_report_id") REFERENCES "status_reports"("id");
