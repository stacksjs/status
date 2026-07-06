ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_status_page_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "status_pages"("id");
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_status_page_component_group_id_fk" FOREIGN KEY ("status_page_component_group_id") REFERENCES "status_page_component_groups"("id");
