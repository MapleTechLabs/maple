ALTER TABLE "chat_workspaces" ADD COLUMN "credentials_ciphertext" text;--> statement-breakpoint
ALTER TABLE "chat_workspaces" ADD COLUMN "credentials_iv" text;--> statement-breakpoint
ALTER TABLE "chat_workspaces" ADD COLUMN "credentials_tag" text;