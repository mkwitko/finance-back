import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../../infra/db/client.js";
import { ERRORS } from "../../../../shared/errors/catalog.js";
import { requireUser } from "../../../hooks/auth/auth.js";
import { createHouseholdsRepository } from "../../households/households.repository.js";
import { createMembersRepository } from "../../households/members.repository.js";
import { syncSeatsSafe } from "../../subscriptions/sync-seats.js";
import { createUsersRepository } from "../../users/users.repository.js";
import { createInvitationsRepository } from "../invitations.repository.js";
import { RedeemResponse } from "../invitations.schema.js";

export const redeemInvitationRoute: FastifyPluginAsync = async (app) => {
  const invites = createInvitationsRepository(db);
  const households = createHouseholdsRepository(db);
  const members = createMembersRepository(db);
  const users = createUsersRepository(db);

  app.withTypeProvider<ZodTypeProvider>().post(
    "/invitations/:code/redeem",
    {
      // NOT household-scoped: caller is not yet a member. Authenticated-only.
      schema: {
        operationId: "redeemInvitation",
        tags: ["invitations"],
        summary: "Redeem an invite code to join a household",
        params: z.object({ code: z.string() }),
        response: { 200: RedeemResponse },
      },
    },
    async (req, reply) => {
      const auth = requireUser(req);
      const code = (req.params as { code: string }).code;
      const invite = await invites.findActiveByCode(code);
      if (!invite) throw ERRORS.INVITATION.EXPIRED();
      const user = await users.findByUuid(auth.sub);
      if (!user) throw ERRORS.AUTH.USER_NOT_FOUND();
      const existing = await members.findMember(invite.householdUuid, auth.sub);
      if (existing) throw ERRORS.INVITATION.ALREADY_MEMBER();
      await households.addMember({
        householdId: invite.householdUuid,
        userId: user.uuid,
        role: invite.role,
        actorUuid: auth.sub,
      });
      await syncSeatsSafe(app, { uuid: invite.householdUuid });
      const joined = await households
        .listForUser(auth.sub)
        .then((hs) => hs.find((h) => h.uuid === invite.householdUuid));
      if (!joined) throw ERRORS.HOUSEHOLD.NOT_FOUND();
      return reply.code(200).send({
        id: joined.uuid,
        name: joined.name,
        type: joined.type,
        ...(joined.role ? { role: joined.role } : {}),
        createdAt: joined.createdAt,
        updatedAt: joined.updatedAt,
      });
    },
  );
};
