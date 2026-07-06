ALTER TABLE "status_page_subscribers" ADD CONSTRAINT "status_page_subscribers_status_page_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "status_pages"("id");
