import type { FastifyPluginAsync } from "fastify";
import { createInvitationRoute } from "./create-invitation/create-invitation.controller.js";
import { listInvitationsRoute } from "./list-invitations/list-invitations.controller.js";
import { redeemInvitationRoute } from "./redeem-invitation/redeem-invitation.controller.js";
import { revokeInvitationRoute } from "./revoke-invitation/revoke-invitation.controller.js";

export const invitationsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(createInvitationRoute);
  await app.register(listInvitationsRoute);
  await app.register(revokeInvitationRoute);
  await app.register(redeemInvitationRoute);
};
