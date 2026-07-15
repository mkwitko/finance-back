import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { db } from "../../../../infra/db/client.js";
import { requireHousehold, requireHouseholdRole } from "../../../hooks/household/household.js";
import { JOIN_LINK, present } from "../invitations.presenter.js";
import { createInvitationsRepository } from "../invitations.repository.js";
import { ListInvitationsResponse } from "../invitations.schema.js";

export const listInvitationsRoute: FastifyPluginAsync = async (app) => {
  const invites = createInvitationsRepository(db);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/households/:id/invitations",
    {
      preHandler: requireHouseholdRole("adult"),
      schema: {
        operationId: "listInvitations",
        tags: ["invitations"],
        summary: "List active invitations for the active household",
        response: { 200: ListInvitationsResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const list = await invites.listActive(hh.uuid);
      return reply.code(200).send({ invitations: list.map((i) => present(i, JOIN_LINK)) });
    },
  );
};
