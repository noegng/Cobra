CREATE TYPE "public"."invoice_source" AS ENUM('chat', 'static_qr', 'dashboard');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('open', 'submitted', 'paid', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('pending', 'sending', 'sent', 'confirmed', 'failed');--> statement-breakpoint
CREATE TABLE "chain_cursor" (
	"id" text PRIMARY KEY NOT NULL,
	"block_number" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"amount_local" text NOT NULL,
	"currency" text NOT NULL,
	"token_out" text NOT NULL,
	"amount_out" text NOT NULL,
	"merchant_address" text NOT NULL,
	"reference" text,
	"description" text,
	"status" "invoice_status" DEFAULT 'open' NOT NULL,
	"source" "invoice_source" DEFAULT 'chat' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"last_reminder_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"display_name" text,
	"country" text NOT NULL,
	"currency" text NOT NULL,
	"settlement_token" text NOT NULL,
	"payout_address" text NOT NULL,
	"payout_address_proven" integer DEFAULT 0 NOT NULL,
	"language" text DEFAULT 'es' NOT NULL,
	"static_slug" text NOT NULL,
	"daily_close_hour" integer DEFAULT 21 NOT NULL,
	"timezone" text DEFAULT 'America/Argentina/Buenos_Aires' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_telegram_user_id_unique" UNIQUE("telegram_user_id"),
	CONSTRAINT "merchants_static_slug_unique" UNIQUE("static_slug")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"payer" text NOT NULL,
	"token_out" text NOT NULL,
	"amount_out" text NOT NULL,
	"legs" jsonb,
	"cost_bps" integer,
	"savings_bps" integer,
	"block_number" bigint NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payments_invoice_id_unique" UNIQUE("invoice_id")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" text NOT NULL,
	"payer" text NOT NULL,
	"plan" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" text NOT NULL,
	"quote_id" uuid,
	"payer" text NOT NULL,
	"legs" jsonb NOT NULL,
	"status" "submission_status" DEFAULT 'pending' NOT NULL,
	"tx_hash" text,
	"tx_nonce" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unmatched_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_merchant_status_idx" ON "invoices" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX "invoices_expires_idx" ON "invoices" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "quotes_invoice_idx" ON "quotes" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_one_live_per_invoice" ON "submissions" USING btree ("invoice_id") WHERE status in ('pending','sending','sent','confirmed');--> statement-breakpoint
CREATE INDEX "submissions_status_idx" ON "submissions" USING btree ("status");