ALTER TABLE "alert_event" ADD COLUMN "severity" text;--> statement-breakpoint
ALTER TABLE "alert_event" ADD COLUMN "muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD COLUMN "detection" text DEFAULT 'threshold' NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD COLUMN "sigma" real;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD COLUMN "severity" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD COLUMN "scope" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD COLUMN "quiet_hours" jsonb;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD COLUMN "updated_at" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "alert_rule_list" ON "alert_rule" USING btree ("project_id","enabled","name");