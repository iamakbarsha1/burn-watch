CREATE TABLE "budget_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"agent" text,
	"monthly_limit_usd" numeric(10, 2) NOT NULL,
	"threshold" numeric(5, 2) DEFAULT '0.8' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claude_enrichment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"cache_hit_rate" numeric(5, 2),
	"written_tokens" bigint DEFAULT 0 NOT NULL,
	"activity_breakdown" jsonb,
	"project_breakdown" jsonb,
	"top_sessions" jsonb,
	"tool_usage" jsonb,
	"shell_usage" jsonb,
	"mcp_usage" jsonb,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "claude_enrichment_unique_user_date" UNIQUE("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "daily_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"date" date NOT NULL,
	"claude_tokens" bigint DEFAULT 0 NOT NULL,
	"claude_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"qwen_tokens" bigint DEFAULT 0 NOT NULL,
	"qwen_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"gemini_tokens" bigint DEFAULT 0 NOT NULL,
	"gemini_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"codex_tokens" bigint DEFAULT 0 NOT NULL,
	"codex_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"copilot_tokens" bigint DEFAULT 0 NOT NULL,
	"copilot_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"cache_hit_rate" numeric(5, 2),
	"models_used" text[],
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "daily_snapshots_unique_user_date" UNIQUE("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "device_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"platform" text NOT NULL,
	"agent_version" text NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'developer' NOT NULL,
	"code" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "org_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"encrypted_token" text NOT NULL,
	"last_sync_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"github_org" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "pending_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"email" text NOT NULL,
	"hostname" text NOT NULL,
	"platform" text NOT NULL,
	"agent_version" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"verified_at" timestamp,
	"device_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pending_devices_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"date" date NOT NULL,
	"model_name" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_create_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"is_free_tier" boolean DEFAULT false NOT NULL,
	"source_raw" jsonb,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_unique_user_agent_date_model_device" UNIQUE("user_id","agent","date","model_name","device_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"github_username" text,
	"role" text DEFAULT 'developer' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"password_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claude_enrichment" ADD CONSTRAINT "claude_enrichment_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_snapshots" ADD CONSTRAINT "daily_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_snapshots" ADD CONSTRAINT "daily_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_integrations" ADD CONSTRAINT "org_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_devices" ADD CONSTRAINT "pending_devices_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claude_enrichment_user_date_idx" ON "claude_enrichment" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "daily_snapshots_org_date_idx" ON "daily_snapshots" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "daily_snapshots_date_cost_idx" ON "daily_snapshots" USING btree ("date","total_cost_usd");--> statement-breakpoint
CREATE INDEX "daily_snapshots_date_tokens_idx" ON "daily_snapshots" USING btree ("date","total_tokens");--> statement-breakpoint
CREATE INDEX "usage_events_user_date_idx" ON "usage_events" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "usage_events_date_total_tokens_idx" ON "usage_events" USING btree ("date","total_tokens");--> statement-breakpoint
CREATE INDEX "usage_events_agent_date_idx" ON "usage_events" USING btree ("agent","date");