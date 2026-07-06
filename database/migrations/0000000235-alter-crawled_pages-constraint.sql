ALTER TABLE "crawled_pages" ADD CONSTRAINT "crawled_pages_crawl_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "crawls"("id");
