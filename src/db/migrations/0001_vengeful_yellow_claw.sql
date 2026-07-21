ALTER TABLE "accounts" ADD COLUMN "email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "password_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_email_unique" UNIQUE("email");