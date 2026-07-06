ALTER TABLE "status_page_component_groups" ADD CONSTRAINT "status_page_component_groups_status_page_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "status_pages"("id");
