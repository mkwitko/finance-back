import { z } from "zod/v4";
import { HOUSEHOLD_TYPES, MEMBERSHIP_ROLES } from "../../../domain/enums.js";

export const CreateHouseholdBody = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(HOUSEHOLD_TYPES),
});
export type CreateHouseholdBody = z.infer<typeof CreateHouseholdBody>;

export const HouseholdView = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.enum(HOUSEHOLD_TYPES),
  role: z.enum(MEMBERSHIP_ROLES).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HouseholdView = z.infer<typeof HouseholdView>;

export const ListHouseholdsResponse = z.object({
  households: z.array(HouseholdView),
});
