-- metadata
ALTER TABLE "morph_spend_readings" DROP CONSTRAINT IF EXISTS "morph_spend_readings_connection_id_cost_connections_id_fk";
--> statement-breakpoint
-- destructive
DROP TABLE IF EXISTS "morph_spend_readings";
