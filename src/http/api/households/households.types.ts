import type { HouseholdType, MembershipRole } from "../../../domain/enums.js";

// Domain household. `id` is the internal bigint PK (never serialized — presenters
// expose `uuid` as `id`). `role` is the CALLER's role, present on "my households".
export type Household = {
  id: number;
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
  ownerUserId: number;
  actorUuid: string;
};

// Minimal shape the RBAC hook needs to authorize a request.
export type MembershipContext = {
  id: number;
  uuid: string;
  type: HouseholdType;
  role: MembershipRole;
};
