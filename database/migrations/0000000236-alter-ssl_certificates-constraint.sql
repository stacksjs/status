ALTER TABLE "ssl_certificates" ADD CONSTRAINT "ssl_certificates_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
