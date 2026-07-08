ALTER TABLE "monitor_notification_channels" ADD COLUMN "fires_on" TEXT CHECK ("fires_on" IN ('down', 'issue', 'both')) default 'both';
