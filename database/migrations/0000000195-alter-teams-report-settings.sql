ALTER TABLE "teams" ADD COLUMN "report_frequency" TEXT default 'none';
ALTER TABLE "teams" ADD COLUMN "report_recipients" TEXT;
ALTER TABLE "teams" ADD COLUMN "report_last_sent_at" TEXT;
