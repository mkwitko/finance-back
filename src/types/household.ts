import type { HouseholdType, MembershipRole } from "../domain/enums.js";

/**
 * Active-household context resolved per request by `requireHousehold`. `uuid` is
 * the household's identity (also the public id the client sent via the
 * `x-household-id` header) plus the caller's `role` in that household.
 */
export type HouseholdContext = {
  uuid: string;
  type: HouseholdType;
  role: MembershipRole;
};
