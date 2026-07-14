import { z } from "zod/v4";
import { MEMBERSHIP_ROLES } from "../../../domain/enums.js";

export const MemberView = z.object({
  userId: z.uuid(),
  name: z.string(),
  role: z.enum(MEMBERSHIP_ROLES),
  joinedAt: z.string(),
});
export const ListMembersResponse = z.object({ members: z.array(MemberView) });
export const UpdateMemberRoleBody = z.object({ role: z.enum(MEMBERSHIP_ROLES) });
export type UpdateMemberRoleBody = z.infer<typeof UpdateMemberRoleBody>;

export const TransferOwnershipBody = z.object({ newOwnerUserId: z.uuid() });
export type TransferOwnershipBody = z.infer<typeof TransferOwnershipBody>;
export const TransferOwnershipResponse = z.object({ ok: z.literal(true) });
