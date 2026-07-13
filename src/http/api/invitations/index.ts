import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod/v4";
import { db } from "../../../infra/db/client.js";
import type { MembershipRole } from "../../../infra/db/tables/households/membership.table.js";
import { ERRORS } from "../../../shared/errors/catalog.js";
import { requireUser } from "../../hooks/auth/auth.js";
import { requireHousehold, requireHouseholdRole } from "../../hooks/household/household.js";
import { createHouseholdsRepository } from "../households/households.repository.js";
import { createMembersRepository } from "../households/members.repository.js";
import { createUsersRepository } from "../users/users.repository.js";
import type { Invitation } from "./invitations.repository.js";
import { createInvitationsRepository } from "./invitations.repository.js";
import {
  CreateInvitationBody,
  InvitationView,
  type InvitationView as InvitationViewT,
  ListInvitationsResponse,
  RedeemResponse,
} from "./invitations.schema.js";

const ROLE_RANK: Record<MembershipRole, number> = {
  owner: 4,
  adult: 3,
  teen: 2,
  child: 1,
  viewer: 0,
};

function present(inv: Invitation, baseUrl: string): InvitationViewT {
  return { ...inv, url: `${baseUrl}${inv.code}` };
}

export const invitationsRoutes: FastifyPluginAsync = async (app) => {
  const invites = createInvitationsRepository(db);
  const households = createHouseholdsRepository(db);
  const members = createMembersRepository(db);
  const users = createUsersRepository(db);
  const JOIN_LINK = "financeapp://join/";

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
        householdId: hh.id,
        role: req.body.role,
        expiresAt,
        actorUuid: requireUser(req).sub,
      });
      return reply.code(201).send(present(created, JOIN_LINK));
    },
  );

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
      const list = await invites.listActive(hh.id);
      return reply.code(200).send({ invitations: list.map((i) => present(i, JOIN_LINK)) });
    },
  );

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
        householdId: hh.id,
        invitationUuid: (req.params as { invId: string }).invId,
        actorUuid: requireUser(req).sub,
      });
      if (!ok) throw ERRORS.INVITATION.NOT_FOUND();
      return reply.code(204).send(null);
    },
  );

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
      const existing = await members.findMember(invite.householdDbId, auth.sub);
      if (existing) throw ERRORS.INVITATION.ALREADY_MEMBER();
      await households.addMember({
        householdId: invite.householdDbId,
        userId: user.id,
        role: invite.role,
        actorUuid: auth.sub,
      });
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
