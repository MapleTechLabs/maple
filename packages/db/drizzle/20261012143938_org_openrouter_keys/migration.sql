-- metadata
CREATE TABLE IF NOT EXISTS "org_openrouter_keys" (
	"org_id" text NOT NULL,
	"key_ciphertext" text NOT NULL,
	"key_iv" text NOT NULL,
	"key_tag" text NOT NULL,
	"key_hint" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "org_openrouter_keys_pkey" PRIMARY KEY ("org_id")
);
