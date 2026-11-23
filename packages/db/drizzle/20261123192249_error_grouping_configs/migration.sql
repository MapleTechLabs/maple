-- metadata
CREATE TABLE IF NOT EXISTS "error_grouping_configs" (
	"org_id" text NOT NULL,
	"rules_json" jsonb NOT NULL DEFAULT '[]',
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	CONSTRAINT "error_grouping_configs_pkey" PRIMARY KEY ("org_id")
);
