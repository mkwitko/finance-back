import "fastify";
import "@fastify/jwt";
import type { AccessTokenClaims, AuthUser } from "./auth.js";
import type { Gateways } from "./fastify.js";
import type { HouseholdContext } from "./household.js";

declare module "fastify" {
  interface FastifyInstance {
    gateways: Gateways;
  }
  // Auth opt-out read by the auth hook. Every non-public route requires a valid token.
  interface FastifyContextConfig {
    public?: boolean;
  }
  interface FastifyRequest {
    // Set by the `requireHousehold` preHandler on household-scoped routes.
    household?: HouseholdContext;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    // What we sign into the access token.
    payload: AccessTokenClaims;
    // What `req.user` holds after the auth hook resolves the token.
    user: AuthUser;
  }
}
