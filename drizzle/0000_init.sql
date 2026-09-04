CREATE TYPE "public"."campaign_status" AS ENUM('DRAFT', 'QUEUED', 'SENDING', 'PAUSED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED');--> statement-breakpoint
CREATE TYPE "public"."smtp_security" AS ENUM('none', 'starttls', 'tls');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('UNSUBSCRIBED', 'MANUAL', 'HARD_BOUNCE', 'COMPLAINT');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_security" "smtp_security" DEFAULT 'starttls' NOT NULL,
	"smtp_user" text,
	"smtp_password_encrypted" text,
	"from_email" text,
	"from_name" text,
	"reply_to" text,
	"max_emails_per_hour" integer DEFAULT 5000 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_lists" (
	"campaign_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	CONSTRAINT "campaign_lists_campaign_id_list_id_pk" PRIMARY KEY("campaign_id","list_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivery_status" "delivery_status" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"lease_expires_at" timestamp with time zone,
	"claimed_by" text,
	"tracking_token" text NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"first_opened_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"from_name" text,
	"from_email" text,
	"reply_to" text,
	"content_html" text DEFAULT '' NOT NULL,
	"compiled_html" text DEFAULT '' NOT NULL,
	"text_body" text,
	"text_body_is_custom" boolean DEFAULT false NOT NULL,
	"status" "campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"total_recipients" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contact_list_members" (
	"list_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_list_members_list_id_contact_id_pk" PRIMARY KEY("list_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "contact_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smtp_send_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"reason" "suppression_reason" NOT NULL,
	"note" text,
	"campaign_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_lists" ADD CONSTRAINT "campaign_lists_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_lists" ADD CONSTRAINT "campaign_lists_list_id_contact_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."contact_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_list_id_contact_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."contact_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_list_members" ADD CONSTRAINT "contact_list_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_campaign_email_key" ON "campaign_recipients" USING btree ("campaign_id","email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_tracking_token_key" ON "campaign_recipients" USING btree ("tracking_token");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_recipients_unsubscribe_token_key" ON "campaign_recipients" USING btree ("unsubscribe_token");--> statement-breakpoint
CREATE INDEX "campaign_recipients_campaign_status_idx" ON "campaign_recipients" USING btree ("campaign_id","delivery_status");--> statement-breakpoint
CREATE INDEX "campaign_recipients_claim_idx" ON "campaign_recipients" USING btree ("delivery_status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "campaign_recipients_email_idx" ON "campaign_recipients" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_created_at_idx" ON "campaigns" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "clm_contact_id_idx" ON "contact_list_members" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_email_normalized_key" ON "contacts" USING btree ("email_normalized");--> statement-breakpoint
CREATE INDEX "contacts_created_at_idx" ON "contacts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "smtp_send_log_occurred_at_idx" ON "smtp_send_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_email_normalized_key" ON "suppressions" USING btree ("email_normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_normalized_key" ON "users" USING btree ("email_normalized");