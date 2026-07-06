ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_incident_id_fk" FOREIGN KEY ("incident_id") REFERENCES "incidents"("id");
