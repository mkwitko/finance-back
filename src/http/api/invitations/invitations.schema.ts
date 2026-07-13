import { z } from "zod/v4";
import { MEMBERSHIP_ROLES } from "../../../infra/db/tables/households/membership.table.js";
import { HouseholdView } from "../households/households.schema.js";

export const CreateInvitationBody = z.object({
  role: z.enum(MEMBERSHIP_ROLES),
  expiresInHours: z.number().int().min(1).max(720).default(168), // 7 days
});
export type CreateInvitationBody = z.infer<typeof CreateInvitationBody>;

export const InvitationView = z.object({
  id: z.uuid(),
  code: z.string(),
  role: z.enum(MEMBERSHIP_ROLES),
  expiresAt: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
export type InvitationView = z.infer<typeof InvitationView>;

export const ListInvitationsResponse = z.object({ invitations: z.array(InvitationView) });
export const RedeemResponse = HouseholdView;
