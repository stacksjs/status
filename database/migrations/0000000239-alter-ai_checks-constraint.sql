ALTER TABLE "ai_checks" ADD CONSTRAINT "ai_checks_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
