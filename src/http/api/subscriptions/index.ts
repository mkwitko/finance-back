import type { FastifyPluginAsync } from "fastify";
import { cancelSubscriptionRoute } from "./cancel-subscription/cancel-subscription.controller.js";
import { checkoutSubscriptionRoute } from "./checkout-subscription/checkout-subscription.controller.js";
import { getSubscriptionRoute } from "./get-subscription/get-subscription.controller.js";
import { switchSubscriptionIntervalRoute } from "./switch-subscription-interval/switch-subscription-interval.controller.js";

export const subscriptionsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(getSubscriptionRoute);
  await app.register(checkoutSubscriptionRoute);
  await app.register(switchSubscriptionIntervalRoute);
  await app.register(cancelSubscriptionRoute);
};
