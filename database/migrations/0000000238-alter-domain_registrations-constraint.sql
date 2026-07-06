ALTER TABLE "domain_registrations" ADD CONSTRAINT "domain_registrations_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
