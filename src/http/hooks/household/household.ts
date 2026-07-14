import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { MembershipRole } from "../../../domain/enums.js";
import { ROLE_RANK } from "../../../domain/enums.js";
import { db } from "../../../infra/db/client.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import type { HouseholdContext } from "../../../types/household.js";
import { createHouseholdsRepository } from "../../api/households/households.repository.js";
import { requireUser } from "../auth/auth.js";

const HOUSEHOLD_HEADER = "x-household-id";

/** Guarantee a resolved household context inside a handler. */
export function requireHousehold(req: FastifyRequest): HouseholdContext {
  if (!req.household) throw ERRORS.HOUSEHOLD.MISSING_CONTEXT();
  return req.household;
}

/**
 * preHandler factory that resolves the active household from the `x-household-id`
 * header, verifies the caller is a member, enforces a minimum role, and attaches
 * `req.household`. Runs AFTER the global auth hook, so `req.user` is populated.
 */
export function requireHouseholdRole(minRole: MembershipRole = "viewer"): preHandlerHookHandler {
  const repo = createHouseholdsRepository(db);
  return async (req) => {
    const user = requireUser(req);
    const householdUuid = req.headers[HOUSEHOLD_HEADER];
    if (typeof householdUuid !== "string" || householdUuid.length === 0) {
      throw ERRORS.HOUSEHOLD.MISSING_CONTEXT();
    }

    const ctx = await repo.findMembershipContext({ userUuid: user.sub, householdUuid });
    if (!ctx) throw ERRORS.HOUSEHOLD.NOT_A_MEMBER();
    if (ROLE_RANK[ctx.role] < ROLE_RANK[minRole]) throw ERRORS.HOUSEHOLD.INSUFFICIENT_ROLE();

    req.household = ctx;
  };
}
