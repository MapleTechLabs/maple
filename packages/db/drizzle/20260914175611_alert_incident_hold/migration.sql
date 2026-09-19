ALTER TABLE "alert_incidents" ADD COLUMN "hold_reason" text;--> statement-breakpoint
ALTER TABLE "alert_incidents" ADD COLUMN "held_since" timestamp with time zone;