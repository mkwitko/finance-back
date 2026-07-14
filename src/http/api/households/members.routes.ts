import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../infra/db/client.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { syncSeatsSafe } from "../subscriptions/sync-seats.js";
import { createMembersRepository } from "./members.repository.js";
import { ListMembersResponse, MemberView, UpdateMemberRoleBody } from "./members.schema.js";

export const membersRoutes: FastifyPluginAsync = async (app) => {
  const members = createMembersRepository(db);

  app.withTypeProvider<ZodTypeProvider>().get(
    "/households/:id/members",
    {
      preHandler: requireHouseholdRole("viewer"),
      schema: {
        operationId: "listMembers",
        tags: ["members"],
        summary: "List members of the active household",
        response: { 200: ListMembersResponse },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const list = await members.listMembers(hh.uuid);
      return reply.code(200).send({ members: list });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().patch(
    "/households/:id/members/:userId",
    {
      preHandler: requireHouseholdRole("owner"),
      schema: {
        operationId: "updateMemberRole",
        tags: ["members"],
        summary: "Change a member's role",
        params: z.object({ id: z.string(), userId: z.uuid() }),
        body: UpdateMemberRoleBody,
        response: { 200: MemberView },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const targetUuid = (req.params as { userId: string }).userId;
      const target = await members.findMember(hh.uuid, targetUuid);
      if (!target) throw ERRORS.HOUSEHOLD.NOT_A_MEMBER();
      // Last-owner guard (demoting the only owner is forbidden) is enforced atomically
      // inside updateRole: count + mutate run under a per-household advisory lock so two
      // concurrent demotions can't both slip through and leave zero owners.
      await members.updateRole({
        householdId: hh.uuid,
        userId: target.userId,
        role: req.body.role,
        actorUuid: requireUser(req).sub,
        guardLastOwner: target.role === "owner" && req.body.role !== "owner",
      });
      const refreshed = await members.listMembers(hh.uuid);
      const view = refreshed.find((m) => m.userId === targetUuid);
      if (!view) throw ERRORS.HOUSEHOLD.NOT_A_MEMBER();
      return reply.code(200).send(view);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().delete(
    "/households/:id/members/:userId",
    {
      // Owner can remove anyone; a non-owner may remove ONLY themselves (leave).
      preHandler: requireHouseholdRole("viewer"),
      schema: {
        operationId: "removeMember",
        tags: ["members"],
        summary: "Remove a member (owner) or leave the household (self)",
        params: z.object({ id: z.string(), userId: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const hh = requireHousehold(req);
      const auth = requireUser(req);
      const targetUuid = (req.params as { userId: string }).userId;
      const isSelf = targetUuid === auth.sub;
      if (!isSelf && hh.role !== "owner") throw ERRORS.HOUSEHOLD.INSUFFICIENT_ROLE();
      const target = await members.findMember(hh.uuid, targetUuid);
      if (!target) throw ERRORS.HOUSEHOLD.NOT_A_MEMBER();
      // Last-owner guard (the only owner cannot be removed / leave) is enforced
      // atomically inside removeMember under a per-household advisory lock, so
      // concurrent leaves can't race the count and drop the household to zero owners.
      await members.removeMember({
        householdId: hh.uuid,
        userId: target.userId,
        actorUuid: auth.sub,
        guardLastOwner: target.role === "owner",
      });
      await syncSeatsSafe(app, { uuid: hh.uuid });
      return reply.code(204).send(null);
    },
  );
};
