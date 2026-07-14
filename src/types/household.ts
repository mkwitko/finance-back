import type { HouseholdType, MembershipRole } from "../domain/enums.js";

/**
 * Active-household context resolved per request by `requireHousehold`. Holds the
 * internal `id` (for scoping DB queries) plus the caller's `role` in that household.
 * `uuid` is the public id the client sent via the `x-household-id` header.
 */
export type HouseholdContext = {
  id: number;
  uuid: string;
  type: HouseholdType;
  role: MembershipRole;
};
