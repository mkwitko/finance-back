import { z } from "zod/v4";
import { MEMBERSHIP_ROLES } from "../../../infra/db/tables/households/membership.table.js";

export const MemberView = z.object({
  userId: z.uuid(),
  name: z.string(),
  role: z.enum(MEMBERSHIP_ROLES),
  joinedAt: z.string(),
});
export const ListMembersResponse = z.object({ members: z.array(MemberView) });
export const UpdateMemberRoleBody = z.object({ role: z.enum(MEMBERSHIP_ROLES) });
export type UpdateMemberRoleBody = z.infer<typeof UpdateMemberRoleBody>;
