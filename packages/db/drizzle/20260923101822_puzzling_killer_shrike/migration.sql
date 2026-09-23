CREATE TABLE "chat_identities" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connector" text NOT NULL,
	"external_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_identities_org_connector_external_idx" ON "chat_identities" ("org_id","connector","external_user_id");--> statement-breakpoint
CREATE INDEX "chat_identities_org_user_idx" ON "chat_identities" ("org_id","user_id");