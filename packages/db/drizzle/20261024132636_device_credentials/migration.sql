-- metadata
CREATE TABLE IF NOT EXISTS "device_credentials" (
	"id" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"jkt" text NOT NULL,
	"roles" jsonb NOT NULL,
	"scopes" jsonb NOT NULL,
	"attested" boolean NOT NULL DEFAULT false,
	"attestation" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"hard_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_credentials_pkey" PRIMARY KEY ("id")
);
--> statement-breakpoint
-- metadata
CREATE TABLE IF NOT EXISTS "device_proof_replays" (
	"key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "device_proof_replays_pkey" PRIMARY KEY ("key")
);
--> statement-breakpoint
-- metadata
CREATE UNIQUE INDEX IF NOT EXISTS "device_credentials_jkt_unique" ON "device_credentials" USING btree ("jkt");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "device_credentials_org_installation_idx" ON "device_credentials" USING btree ("org_id", "installation_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "device_credentials_user_idx" ON "device_credentials" USING btree ("user_id");
--> statement-breakpoint
-- metadata
CREATE INDEX IF NOT EXISTS "device_proof_replays_expires_idx" ON "device_proof_replays" USING btree ("expires_at");
