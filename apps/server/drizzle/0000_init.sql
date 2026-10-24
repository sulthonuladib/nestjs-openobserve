CREATE TABLE "alert_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"state" text NOT NULL,
	"started_at" bigint NOT NULL,
	"resolved_at" bigint,
	"value" double precision,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "alert_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"application_id" uuid,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" double precision NOT NULL,
	"window_s" integer NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"muted_until" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_credential" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"secret_hash" text NOT NULL,
	"label" text,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "app_credential_key_prefix_unique" UNIQUE("key_prefix")
);
--> statement-breakpoint
CREATE TABLE "application" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"service_id" text NOT NULL,
	"name" text,
	"first_seen" bigint NOT NULL,
	"last_seen" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cli_link_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"application_name" text NOT NULL,
	"hostname" text,
	"project_id" uuid,
	"application_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"interval_s" integer DEFAULT 5 NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"approved_at" bigint
);
--> statement-breakpoint
CREATE TABLE "drop_filter" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"field" text NOT NULL,
	"matcher" text NOT NULL,
	"pattern" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_group" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"class" text,
	"message" text NOT NULL,
	"top_frame_file" text,
	"top_frame_line" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen" bigint NOT NULL,
	"last_seen" bigint NOT NULL,
	"occurrences" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_occurrence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"error_group_id" uuid NOT NULL,
	"execution_id" uuid,
	"release_id" uuid,
	"occurred_at" bigint NOT NULL,
	"stack" text,
	"source_context" jsonb
);
--> statement-breakpoint
CREATE TABLE "execution" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"release_id" uuid,
	"operation_row_id" uuid,
	"kind" text NOT NULL,
	"protocol" text,
	"trace_id" text NOT NULL,
	"started_at" bigint NOT NULL,
	"called_at" text,
	"duration_ms" double precision,
	"status_code" integer,
	"user_id" text,
	"error_group_id" uuid,
	"queue" text,
	"job_name" text,
	"job_status" text,
	"wait_ms" double precision,
	"attempts_made" integer,
	"max_attempts" integer,
	"enqueued_at" text,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request" jsonb,
	"span_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"occurred_at" bigint NOT NULL,
	"level" text,
	"context" text,
	"text" text NOT NULL,
	"trace_id" text,
	"span_id" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_point" (
	"series_id" uuid NOT NULL,
	"at" bigint NOT NULL,
	"value" real,
	"count" real,
	"sum" real,
	"min" real,
	"max" real,
	"q50" real,
	"q95" real,
	"q99" real,
	CONSTRAINT "metric_point_series_id_at_pk" PRIMARY KEY("series_id","at")
);
--> statement-breakpoint
CREATE TABLE "metric_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"kind" text,
	"labels_hash" text NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"protocol" text NOT NULL,
	"operation_id" text NOT NULL,
	"method" text,
	"custom_name" text,
	"first_seen" bigint NOT NULL,
	"last_seen" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "project_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "release" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"version" text NOT NULL,
	"first_seen" bigint NOT NULL,
	"last_seen" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"data_class" text NOT NULL,
	"days" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rollup_minute" (
	"application_id" uuid NOT NULL,
	"at" bigint NOT NULL,
	"operation_row_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"client_error_count" integer DEFAULT 0 NOT NULL,
	"duration_sum" double precision DEFAULT 0 NOT NULL,
	"duration_hist" integer[] DEFAULT '{}'::integer[] NOT NULL,
	CONSTRAINT "rollup_minute_application_id_at_operation_row_id_kind_pk" PRIMARY KEY("application_id","at","operation_row_id","kind")
);
--> statement-breakpoint
CREATE TABLE "runtime_sample" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"received_at" bigint NOT NULL,
	"cpu" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"memory" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"gc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_loop" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schema_migration" (
	"version" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"applied_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slo" (
	"id" uuid PRIMARY KEY NOT NULL,
	"application_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"method" text,
	"name" text,
	"kind" text NOT NULL,
	"target" double precision NOT NULL,
	"under_ms" double precision,
	"window_days" integer DEFAULT 28 NOT NULL,
	"source" text DEFAULT 'code' NOT NULL,
	"handler" text,
	"release_id" uuid,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "span" (
	"id" uuid PRIMARY KEY NOT NULL,
	"execution_id" uuid NOT NULL,
	"parent_id" uuid,
	"span_id" text,
	"name" text,
	"origin" text NOT NULL,
	"class_name" text NOT NULL,
	"method" text NOT NULL,
	"duration_ms" double precision,
	"start_offset_ms" double precision,
	"error" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"collapsed_count" integer,
	"depth" integer DEFAULT 0 NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" bigint NOT NULL,
	"last_login_at" bigint,
	CONSTRAINT "app_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_rule_id_alert_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_credential" ADD CONSTRAINT "app_credential_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_link_session" ADD CONSTRAINT "cli_link_session_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_link_session" ADD CONSTRAINT "cli_link_session_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_filter" ADD CONSTRAINT "drop_filter_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_group" ADD CONSTRAINT "error_group_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_occurrence" ADD CONSTRAINT "error_occurrence_error_group_id_error_group_id_fk" FOREIGN KEY ("error_group_id") REFERENCES "public"."error_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_occurrence" ADD CONSTRAINT "error_occurrence_execution_id_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."execution"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_occurrence" ADD CONSTRAINT "error_occurrence_release_id_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."release"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution" ADD CONSTRAINT "execution_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution" ADD CONSTRAINT "execution_release_id_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."release"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution" ADD CONSTRAINT "execution_operation_row_id_operation_id_fk" FOREIGN KEY ("operation_row_id") REFERENCES "public"."operation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution" ADD CONSTRAINT "execution_error_group_id_error_group_id_fk" FOREIGN KEY ("error_group_id") REFERENCES "public"."error_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_entry" ADD CONSTRAINT "log_entry_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_point" ADD CONSTRAINT "metric_point_series_id_metric_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."metric_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_series" ADD CONSTRAINT "metric_series_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation" ADD CONSTRAINT "operation_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy" ADD CONSTRAINT "retention_policy_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_sample" ADD CONSTRAINT "runtime_sample_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slo" ADD CONSTRAINT "slo_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slo" ADD CONSTRAINT "slo_release_id_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."release"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "span" ADD CONSTRAINT "span_execution_id_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."execution"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_event_rule" ON "alert_event" USING btree ("rule_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_credential_key" ON "app_credential" USING btree ("key_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "application_service" ON "application" USING btree ("project_id","service_id");--> statement-breakpoint
CREATE INDEX "application_last_seen" ON "application" USING btree ("last_seen");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_link_device_code" ON "cli_link_session" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_link_user_code" ON "cli_link_session" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "cli_link_status" ON "cli_link_session" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "error_group_fingerprint" ON "error_group" USING btree ("application_id","fingerprint");--> statement-breakpoint
CREATE INDEX "error_group_list" ON "error_group" USING btree ("application_id","status","last_seen");--> statement-breakpoint
CREATE INDEX "error_occurrence_group" ON "error_occurrence" USING btree ("error_group_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "execution_time" ON "execution" USING btree ("application_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "execution_trace" ON "execution" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "execution_operation" ON "execution" USING btree ("application_id","operation_row_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "execution_errors" ON "execution" USING btree ("error_group_id");--> statement-breakpoint
CREATE INDEX "execution_tags" ON "execution" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "log_time" ON "log_entry" USING btree ("application_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "log_trace" ON "log_entry" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "log_level" ON "log_entry" USING btree ("application_id","level","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "metric_point_at" ON "metric_point" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "metric_series_identity" ON "metric_series" USING btree ("application_id","name","labels_hash");--> statement-breakpoint
CREATE INDEX "metric_series_labels" ON "metric_series" USING gin ("labels");--> statement-breakpoint
CREATE UNIQUE INDEX "operation_identity" ON "operation" USING btree ("application_id","protocol","operation_id");--> statement-breakpoint
CREATE INDEX "operation_seen" ON "operation" USING btree ("application_id","last_seen");--> statement-breakpoint
CREATE UNIQUE INDEX "release_version" ON "release" USING btree ("application_id","version");--> statement-breakpoint
CREATE INDEX "release_seen" ON "release" USING btree ("application_id","last_seen");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_class" ON "retention_policy" USING btree ("project_id","data_class");--> statement-breakpoint
CREATE INDEX "rollup_minute_time" ON "rollup_minute" USING btree ("application_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "runtime_time" ON "runtime_sample" USING btree ("application_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "session_token" ON "session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_expires" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slo_identity" ON "slo" USING btree ("application_id","operation_id","kind","under_ms");--> statement-breakpoint
CREATE INDEX "span_execution" ON "span" USING btree ("execution_id","depth","seq");--> statement-breakpoint
CREATE INDEX "span_class" ON "span" USING btree ("class_name","method");--> statement-breakpoint
CREATE INDEX "span_name" ON "span" USING btree ("name");