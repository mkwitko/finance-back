import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { env, googleClientIds } from "../../../config/env.js";
import { createDeepseekGateway } from "../../../gateways/deepseek/deepseek.gateway.js";
import { createGoogleGateway } from "../../../gateways/google/google.gateway.js";
import type { Gateways } from "../../../types/fastify.js";

export function buildDefaultGateways(): Gateways {
  return {
    google: createGoogleGateway({ clientIds: googleClientIds() }),
    deepseek: createDeepseekGateway({
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_BASE_URL,
      model: env.DEEPSEEK_MODEL,
    }),
  };
}

const _gatewaysPlugin: FastifyPluginAsync<{ gateways?: Gateways }> = async (app, opts) => {
  // Default: real instances. In tests, a complete set of fakes is passed via opts.
  const gateways = opts.gateways ?? buildDefaultGateways();
  app.decorate("gateways", gateways);
};

export const gatewaysPlugin = fp(_gatewaysPlugin, { fastify: "5.x", name: "gateways" });
