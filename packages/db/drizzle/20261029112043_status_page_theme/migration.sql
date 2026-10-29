-- metadata
ALTER TABLE "status_pages" ADD COLUMN IF NOT EXISTS "theme" jsonb NOT NULL DEFAULT '{"preset":"default","appearance":"auto","accent":null,"background":null,"text":null,"card":null,"border":null,"radius":"md","font":"sans"}';
--> statement-breakpoint
-- data: an existing brand colour becomes the theme accent
UPDATE "status_pages" SET "theme" = jsonb_set("theme", '{accent}', to_jsonb(lower("brand_color"))) WHERE "brand_color" ~ '^#[0-9a-fA-F]{6}$';
--> statement-breakpoint
-- destructive
ALTER TABLE "status_pages" DROP COLUMN IF EXISTS "brand_color";
