-- PR review confidence moved from 1-5 to 1-10: double stored values so history reads on one scale.
-- Only values still on the old scale are touched, and a stored "Held at N" cap reason doubles with them.
UPDATE "pr_reviews"
SET "report_json" = CASE
	WHEN "report_json"->>'confidenceReason' ~ '^Held at [1-5] '
		THEN jsonb_set(
			"report_json",
			'{confidenceReason}',
			to_jsonb(regexp_replace(
				"report_json"->>'confidenceReason',
				'^Held at [1-5] ',
				'Held at ' || (substring("report_json"->>'confidenceReason' from '^Held at ([1-5]) ')::int * 2) || ' '
			))
		)
	ELSE "report_json"
END || jsonb_build_object('confidence', ("report_json"->>'confidence')::int * 2)
WHERE jsonb_typeof("report_json"->'confidence') = 'number'
	AND ("report_json"->>'confidence')::numeric BETWEEN 1 AND 5;
