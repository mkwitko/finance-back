CREATE TABLE "invitation" (
	"invitation_id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "invitation_invitation_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"uuid" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"household_id" bigint NOT NULL,
	"code" varchar(12) NOT NULL,
	"role" varchar(16) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invitation_uuid_unique" UNIQUE("uuid")
);
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_household_id_household_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_invitation_code" ON "invitation" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_invitation_household" ON "invitation" USING btree ("household_id");