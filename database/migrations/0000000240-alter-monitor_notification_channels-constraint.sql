ALTER TABLE "monitor_notification_channels" ADD CONSTRAINT "monitor_notification_channels_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
ALTER TABLE "monitor_notification_channels" ADD CONSTRAINT "monitor_notification_channels_notification_channel_id_fk" FOREIGN KEY ("notification_channel_id") REFERENCES "notification_channels"("id");
