import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ROLE_RANK } from "../../../../domain/enums.js";
import { db } from "../../../../infra/db/client.js";
import { ERRORS } from "../../../../shared/errors/catalog.js";
import { requireUser } from "../../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../../hooks/household/household.js";
import { JOIN_LINK, present } from "../invitations.presenter.js";
import { createInvitationsRepository } from "../invitations.repository.js";
import { CreateInvitationBody, InvitationView } from "../invitations.schema.js";

export const createInvitationRoute: FastifyPluginAsync = async (app) => {
  const invites = createInvitationsRepository(db);

  app.withTypeProvider<ZodTypeProvider>().post(
    "/households/:id/invitations",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "createInvitation",
        tags: ["invitations"],
        summary: "Create a shareable invite code for the active household",
        body: CreateInvitationBody,
        response: { 201: InvitationView },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      // Role ceiling: cannot grant a role above the caller's own.
      if (ROLE_RANK[req.body.role] > ROLE_RANK[hh.role]) throw ERRORS.INVITATION.ROLE_TOO_HIGH();
      const expiresAt = new Date(Date.now() + req.body.expiresInHours * 3600_000);
      const created = await invites.create({
        householdId: hh.uuid,
        role: req.body.role,
        expiresAt,
        actorUuid: requireUser(req).sub,
      });
      return reply.code(201).send(present(created, JOIN_LINK));
    },
  );
};
