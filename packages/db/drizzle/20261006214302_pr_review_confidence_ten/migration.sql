-- PR review confidence moved from 1-5 to 1-10: double stored values so history reads on one scale.
-- Runs once, in the deploy that ships the 1-10 scale, before any review is stored on it.
UPDATE "pr_reviews"
SET "report_json" = jsonb_set("report_json", '{confidence}', to_jsonb(("report_json"->>'confidence')::int * 2))
WHERE jsonb_typeof("report_json"->'confidence') = 'number';
