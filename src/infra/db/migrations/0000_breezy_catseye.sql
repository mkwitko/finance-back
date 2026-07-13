CREATE TABLE "account" (
	"account_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_account_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"household_id" bigint NOT NULL,
	"name" varchar(255) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"institution" varchar(255),
	"currency" char(3) DEFAULT 'BRL' NOT NULL,
	CONSTRAINT "account_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "refresh_token" (
	"refresh_token_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "refresh_token_refresh_token_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"user_id" bigint NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "refresh_token_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "refresh_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "category" (
	"category_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "category_category_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"household_id" bigint,
	"name" varchar(128) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"parent_id" bigint,
	"icon" varchar(64),
	CONSTRAINT "category_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "goal" (
	"goal_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "goal_goal_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"household_id" bigint NOT NULL,
	"type" varchar(32) NOT NULL,
	"name" varchar(255) NOT NULL,
	"target_amount_cents" bigint,
	"target_date" timestamp with time zone,
	"current_amount_cents" bigint DEFAULT 0 NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "goal_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "household" (
	"household_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "household_household_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" varchar(255) NOT NULL,
	"type" varchar(32) NOT NULL,
	CONSTRAINT "household_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"membership_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "membership_membership_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"user_id" bigint NOT NULL,
	"household_id" bigint NOT NULL,
	"role" varchar(16) NOT NULL,
	CONSTRAINT "membership_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "import_batch" (
	"import_batch_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "import_batch_import_batch_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"household_id" bigint NOT NULL,
	"source" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"file_ref" varchar(1024),
	"transaction_count" integer DEFAULT 0 NOT NULL,
	"error" varchar(1024),
	CONSTRAINT "import_batch_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "transaction" (
	"transaction_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "transaction_transaction_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"account_id" bigint NOT NULL,
	"category_id" bigint,
	"import_batch_id" bigint,
	"amount_cents" bigint NOT NULL,
	"direction" varchar(8) NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"description" varchar(512) NOT NULL,
	"source" varchar(16) NOT NULL,
	"raw_ref" varchar(512),
	"ai_categorized" boolean DEFAULT false NOT NULL,
	"ai_confidence" integer,
	CONSTRAINT "transaction_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"user_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_user_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"google_sub" varchar(255) NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(255) NOT NULL,
	"picture" varchar(1024),
	"email_verified" boolean DEFAULT false NOT NULL,
	CONSTRAINT "user_uuid_unique" UNIQUE("uuid"),
	CONSTRAINT "user_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_household_id_household_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_user_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_household_id_household_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_parent_id_category_category_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."category"("category_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_household_id_household_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_household_id_household_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_household_id_household_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_account_id_account_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_category_id_category_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("category_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_import_batch_id_import_batch_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batch"("import_batch_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_household" ON "account" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_token_user" ON "refresh_token" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_category_household" ON "category" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "idx_goal_household" ON "goal" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "idx_household_cursor" ON "household" USING btree ("created_at","household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_membership_user_household" ON "membership" USING btree ("user_id","household_id");--> statement-breakpoint
CREATE INDEX "idx_membership_household" ON "membership" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "idx_import_batch_household" ON "import_batch" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "idx_transaction_account_date" ON "transaction" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "idx_transaction_category" ON "transaction" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "idx_user_cursor" ON "user" USING btree ("created_at","user_id");