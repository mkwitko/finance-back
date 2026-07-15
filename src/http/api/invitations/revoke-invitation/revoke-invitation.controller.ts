import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../../infra/db/client.js";
import { ERRORS } from "../../../../shared/errors/catalog.js";
import { requireUser } from "../../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../../hooks/household/household.js";
import { createInvitationsRepository } from "../invitations.repository.js";

export const revokeInvitationRoute: FastifyPluginAsync = async (app) => {
  const invites = createInvitationsRepository(db);

  app.withTypeProvider<ZodTypeProvider>().delete(
    "/households/:id/invitations/:invId",
    {
      preHandler: requireHouseholdRole("owner"),
      schema: {
        operationId: "revokeInvitation",
        tags: ["invitations"],
        summary: "Revoke an invitation",
        params: z.object({ id: z.string(), invId: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const ok = await invites.revoke({
        householdId: hh.uuid,
        invitationUuid: (req.params as { invId: string }).invId,
        actorUuid: requireUser(req).sub,
      });
      if (!ok) throw ERRORS.INVITATION.NOT_FOUND();
      return reply.code(204).send(null);
    },
  );
};
