-- metadata
ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "cost_budget_json" jsonb;
