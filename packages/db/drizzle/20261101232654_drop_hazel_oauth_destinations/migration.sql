-- Retire the `hazel-oauth` alert destination (#2022 removed its transport and type), as
-- 20260924110710_drop_legacy_slack did for `slack-bot`. Rows of a type the code no longer
-- decodes crashed the dashboard's alert and automation pages. Every reference goes with them:
-- a rule left with no destination is disabled, since an enabled rule must name one; an
-- escalation severity left with none is dropped; the error policy may name none.
UPDATE "alert_rules" AS rules
SET
	"destination_ids_json" = COALESCE(
		(
			SELECT jsonb_agg(destination_id)
			FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(rules."destination_ids_json") = 'array' THEN rules."destination_ids_json" ELSE '[]'::jsonb END) AS ids(destination_id)
			WHERE destination_id NOT IN (SELECT "id" FROM "alert_destinations" WHERE "type" = 'hazel-oauth')
		),
		'[]'::jsonb
	),
	"enabled" = rules."enabled" AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(rules."destination_ids_json") = 'array' THEN rules."destination_ids_json" ELSE '[]'::jsonb END) AS ids(destination_id)
		WHERE destination_id NOT IN (SELECT "id" FROM "alert_destinations" WHERE "type" = 'hazel-oauth')
	)
WHERE jsonb_typeof(rules."destination_ids_json") = 'array'
	AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(rules."destination_ids_json") = 'array' THEN rules."destination_ids_json" ELSE '[]'::jsonb END) AS ids(destination_id)
		JOIN "alert_destinations" AS destinations ON destinations."id" = destination_id
		WHERE destinations."type" = 'hazel-oauth'
	);--> statement-breakpoint
UPDATE "error_notification_policies" AS policies
SET "destination_ids_json" = COALESCE(
	(
		SELECT jsonb_agg(destination_id)
		FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(policies."destination_ids_json") = 'array' THEN policies."destination_ids_json" ELSE '[]'::jsonb END) AS ids(destination_id)
		WHERE destination_id NOT IN (SELECT "id" FROM "alert_destinations" WHERE "type" = 'hazel-oauth')
	),
	'[]'::jsonb
)
WHERE jsonb_typeof(policies."destination_ids_json") = 'array'
	AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(policies."destination_ids_json") = 'array' THEN policies."destination_ids_json" ELSE '[]'::jsonb END) AS ids(destination_id)
		JOIN "alert_destinations" AS destinations ON destinations."id" = destination_id
		WHERE destinations."type" = 'hazel-oauth'
	);--> statement-breakpoint
UPDATE "issue_escalation_policies" AS policies
SET "rules_json" = COALESCE(
	(
		SELECT jsonb_agg(jsonb_set(rule, '{destinationIds}', kept.ids) ORDER BY rules.position)
		FROM jsonb_array_elements(CASE WHEN jsonb_typeof(policies."rules_json") = 'array' THEN policies."rules_json" ELSE '[]'::jsonb END) WITH ORDINALITY AS rules(rule, position)
		CROSS JOIN LATERAL (
			SELECT COALESCE(jsonb_agg(destination_id), '[]'::jsonb) AS ids
			FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(rule -> 'destinationIds') = 'array' THEN rule -> 'destinationIds' ELSE '[]'::jsonb END) AS ids(destination_id)
			WHERE destination_id NOT IN (SELECT "id" FROM "alert_destinations" WHERE "type" = 'hazel-oauth')
		) AS kept
		WHERE jsonb_array_length(kept.ids) > 0
	),
	'[]'::jsonb
)
WHERE jsonb_typeof(policies."rules_json") = 'array'
	AND NOT EXISTS (
		SELECT 1
		FROM jsonb_array_elements(CASE WHEN jsonb_typeof(policies."rules_json") = 'array' THEN policies."rules_json" ELSE '[]'::jsonb END) AS rules(rule)
		WHERE jsonb_typeof(rule -> 'destinationIds') IS DISTINCT FROM 'array'
	)
	AND EXISTS (
		SELECT 1
		FROM jsonb_array_elements(CASE WHEN jsonb_typeof(policies."rules_json") = 'array' THEN policies."rules_json" ELSE '[]'::jsonb END) AS rules(rule)
		CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(rule -> 'destinationIds') = 'array' THEN rule -> 'destinationIds' ELSE '[]'::jsonb END) AS ids(destination_id)
		JOIN "alert_destinations" AS destinations ON destinations."id" = ids.destination_id
		WHERE destinations."type" = 'hazel-oauth'
	);--> statement-breakpoint
DELETE FROM "error_notification_deliveries"
WHERE "destination_id" IN (SELECT "id" FROM "alert_destinations" WHERE "type" = 'hazel-oauth');--> statement-breakpoint
DELETE FROM "alert_delivery_events"
WHERE "destination_id" IN (SELECT "id" FROM "alert_destinations" WHERE "type" = 'hazel-oauth');--> statement-breakpoint
DELETE FROM "alert_destinations"
WHERE "type" = 'hazel-oauth';
