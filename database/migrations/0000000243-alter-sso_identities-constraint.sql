ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
