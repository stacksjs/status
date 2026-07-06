ALTER TABLE "maintenance_window_monitors" ADD CONSTRAINT "maintenance_window_monitors_maintenance_window_id_fk" FOREIGN KEY ("maintenance_window_id") REFERENCES "maintenance_windows"("id");
ALTER TABLE "maintenance_window_monitors" ADD CONSTRAINT "maintenance_window_monitors_monitor_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "monitors"("id");
