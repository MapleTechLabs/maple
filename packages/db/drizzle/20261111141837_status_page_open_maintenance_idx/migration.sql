-- metadata
CREATE INDEX IF NOT EXISTS "status_page_incidents_open_maintenance_idx" ON "status_page_incidents" USING btree ("scheduled_start") WHERE "kind" = 'maintenance' and "resolved_at" is null;
