-- metadata
CREATE INDEX IF NOT EXISTS "alert_member_notifications_org_user_idx" ON "alert_member_notifications" USING btree ("org_id", "user_id");
