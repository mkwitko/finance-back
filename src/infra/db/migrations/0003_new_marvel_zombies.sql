CREATE TABLE "subscription" (
	"subscription_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subscription_subscription_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"household_id" bigint NOT NULL,
	"plan" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"provider" varchar(16) DEFAULT 'stub' NOT NULL,
	"provider_ref" varchar(255),
	"current_period_end" timestamp with time zone,
	CONSTRAINT "subscription_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_household_id_household_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subscription_household" ON "subscription" USING btree ("household_id") WHERE "subscription"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_subscription_household" ON "subscription" USING btree ("household_id");