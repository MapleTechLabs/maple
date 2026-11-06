-- metadata
CREATE TABLE IF NOT EXISTS "oncall_overrides" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"schedule_id" text NOT NULL,
	"user_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oncall_overrides_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "oncall_schedules" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"time_zone" text NOT NULL,
	"layers_json" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "oncall_schedules_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "oncall_overrides_org_schedule_ends_idx" ON "oncall_overrides" USING btree ("org_id", "schedule_id", "ends_at");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "oncall_schedules_org_idx" ON "oncall_schedules" USING btree ("org_id");
--> statement-breakpoint
-- metadata
ALTER TABLE "oncall_overrides" ADD CONSTRAINT "oncall_overrides_schedule_id_oncall_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "oncall_schedules" ("id") ON DELETE CASCADE;
