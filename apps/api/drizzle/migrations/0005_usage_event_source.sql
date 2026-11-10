ALTER TABLE "usage_events" DROP CONSTRAINT "usage_events_unique_user_agent_date_model_device";--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "device_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "source" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_unique_user_agent_date_model_device_source" UNIQUE NULLS NOT DISTINCT("user_id","agent","date","model_name","device_id","source");