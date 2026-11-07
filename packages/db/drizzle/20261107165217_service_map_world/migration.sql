-- metadata
CREATE TABLE IF NOT EXISTS "service_map_world_entities" (
	"org_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "service_map_world_entities_pkey" PRIMARY KEY ("org_id", "entity_id")
);
