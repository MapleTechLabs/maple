CREATE TABLE "org_support_channels" (
	"org_id" text PRIMARY KEY,
	"slack_channel_id" text,
	"slack_channel_name" text,
	"reserved_at" timestamp with time zone,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
