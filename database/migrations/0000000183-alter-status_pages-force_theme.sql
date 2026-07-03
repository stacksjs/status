ALTER TABLE "status_pages" ADD COLUMN "force_theme" TEXT CHECK ("force_theme" IN ('dark', 'light', 'system')) default 'system';
