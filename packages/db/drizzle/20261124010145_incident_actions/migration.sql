-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "first_acknowledged_at" timestamp with time zone;
--> statement-breakpoint
-- An incident acknowledged before this column existed keeps its first acknowledgement from its history.
UPDATE "alert_incidents" AS incident
SET "first_acknowledged_at" = history."first_at"
FROM (
	SELECT "incident_id", min("created_at") AS "first_at"
	FROM "alert_incident_events"
	WHERE "type" = 'acknowledged'
	GROUP BY "incident_id"
) AS history
WHERE incident."id" = history."incident_id"
	AND incident."first_acknowledged_at" IS NULL;
--> statement-breakpoint
-- One with no history left still has the acknowledgement that stands.
UPDATE "alert_incidents"
SET "first_acknowledged_at" = "acknowledged_at"
WHERE "first_acknowledged_at" IS NULL
	AND "acknowledged_at" IS NOT NULL;
--> statement-breakpoint
-- metadata
ALTER TABLE "alert_incidents" ADD COLUMN IF NOT EXISTS "quiet_since" timestamp with time zone;
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "alert_incidents_quiet_idx" ON "alert_incidents" USING btree ("org_id", "rule_id") WHERE "quiet_since" IS NOT NULL;
