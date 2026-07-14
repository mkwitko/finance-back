import type { HouseholdType, MembershipRole } from "../../../domain/enums.js";

// Domain household. `uuid` is the identity — presenters expose it as `id` on the
// wire. `role` is the CALLER's role, present on "my households".
export type Household = {
  uuid: string;
  name: string;
  type: HouseholdType;
  role?: MembershipRole;
  createdAt: string;
  updatedAt: string;
};

export type CreateHouseholdInput = {
  name: string;
  type: HouseholdType;
  ownerUserUuid: string;
  actorUuid: string;
};

// Minimal shape the RBAC hook needs to authorize a request.
export type MembershipContext = {
  uuid: string;
  type: HouseholdType;
  role: MembershipRole;
};
