-- Reviews stored before the general reviewer were observability-only: rename their verdicts and
-- give every finding the category the report schema now requires.
UPDATE "pr_reviews"
SET "report_json" = jsonb_set(
	jsonb_set(
		"report_json",
		'{verdict}',
		to_jsonb(CASE "report_json"->>'verdict'
			WHEN 'gaps' THEN 'issues'
			WHEN 'instrumented' THEN 'clean'
			ELSE "report_json"->>'verdict'
		END)
	),
	'{findings}',
	COALESCE(
		(SELECT jsonb_agg("finding" || '{"category":"observability"}'::jsonb)
			FROM jsonb_array_elements("report_json"->'findings') AS "finding"),
		'[]'::jsonb
	)
)
WHERE "report_json" IS NOT NULL;
