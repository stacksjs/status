ALTER TABLE "status_pages" ADD COLUMN "access_type" TEXT CHECK ("access_type" IN ('public', 'password', 'email_domain', 'ip_allowlist')) default 'public';
