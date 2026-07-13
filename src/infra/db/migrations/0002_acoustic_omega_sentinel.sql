CREATE TABLE "insight" (
	"insight_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "insight_insight_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"household_id" bigint NOT NULL,
	"kind" varchar(24) NOT NULL,
	"severity" varchar(16) NOT NULL,
	"title" varchar(255) NOT NULL,
	"body" text NOT NULL,
	"recommendation" text,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "insight_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
ALTER TABLE "insight" ADD CONSTRAINT "insight_household_id_household_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_insight_household" ON "insight" USING btree ("household_id");