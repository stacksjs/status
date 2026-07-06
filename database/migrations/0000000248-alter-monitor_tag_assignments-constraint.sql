ALTER TABLE "monitor_tag_assignments" ADD CONSTRAINT "monitor_tag_assignments_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
ALTER TABLE "monitor_tag_assignments" ADD CONSTRAINT "monitor_tag_assignments_monitor_tag_id_fk" FOREIGN KEY ("monitor_tag_id") REFERENCES "monitor_tags"("id");
