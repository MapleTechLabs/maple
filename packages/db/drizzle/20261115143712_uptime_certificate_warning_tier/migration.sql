-- Uptime rules gain a warning tier at 0.5 (an HTTPS certificate inside its expiry window), notifying
-- the same destinations as the critical one. `uptimeRuleFields` writes both tiers for new and edited
-- monitors; this brings the existing single-tier rules along. Idempotent: only one-tier rules match.
UPDATE "alert_rules"
SET
	"thresholds_json" = jsonb_build_array(
		jsonb_build_object(
			'severity', 'warning',
			'value', 0.5,
			'upper', NULL,
			'recoveryValue', NULL,
			'destinationIds', COALESCE("thresholds_json" -> 0 -> 'destinationIds', '[]'::jsonb)
		)
	) || "thresholds_json",
	"threshold" = 0.5
WHERE "signal_type" = 'uptime'
	AND jsonb_typeof("thresholds_json") = 'array'
	AND jsonb_array_length("thresholds_json") = 1
	AND "thresholds_json" -> 0 ->> 'severity' = 'critical';
--> statement-breakpoint
-- A rule from before tiers reads as one critical tier from its legacy columns; write both tiers.
UPDATE "alert_rules"
SET
	"thresholds_json" = jsonb_build_array(
		jsonb_build_object(
			'severity', 'warning', 'value', 0.5, 'upper', NULL, 'recoveryValue', NULL,
			'destinationIds', COALESCE("destination_ids_json", '[]'::jsonb)
		),
		jsonb_build_object(
			'severity', 'critical', 'value', 1, 'upper', NULL, 'recoveryValue', NULL,
			'destinationIds', COALESCE("destination_ids_json", '[]'::jsonb)
		)
	),
	"threshold" = 0.5
WHERE "signal_type" = 'uptime' AND "thresholds_json" IS NULL;
