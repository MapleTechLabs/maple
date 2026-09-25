-- Retire the `slack-bot` alert destination: its bot token lived in
-- `slack_workspaces`, so without that table it can never deliver again. A rule
-- loses the retired destinations, and one left with none is disabled, since an
-- enabled rule must name a destination.
UPDATE "alert_rules" AS rules
SET
	"destination_ids_json" = COALESCE(
		(
			SELECT jsonb_agg(destination_id)
			FROM jsonb_array_elements_text(rules."destination_ids_json") AS ids(destination_id)
			WHERE destination_id NOT IN (SELECT "id" FROM "alert_destinations" WHERE "type" = 'slack-bot')
		),
		'[]'::jsonb
	),
	"enabled" = rules."enabled" AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements_text(rules."destination_ids_json") AS ids(destination_id)
		WHERE destination_id NOT IN (SELECT "id" FROM "alert_destinations" WHERE "type" = 'slack-bot')
	)
WHERE EXISTS (
	SELECT 1
	FROM jsonb_array_elements_text(rules."destination_ids_json") AS ids(destination_id)
	JOIN "alert_destinations" AS destinations ON destinations."id" = destination_id
	WHERE destinations."type" = 'slack-bot'
);--> statement-breakpoint
DELETE FROM "alert_delivery_events"
WHERE "destination_id" IN (SELECT "id" FROM "alert_destinations" WHERE "type" = 'slack-bot');--> statement-breakpoint
DELETE FROM "alert_destinations"
WHERE "type" = 'slack-bot';--> statement-breakpoint
DROP TABLE IF EXISTS "slack_workspaces";
