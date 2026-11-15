import { RouteTable } from "../route-table.js";
import { registerEnhancementRoutes } from "./enhancement.js";
import { requestError } from "./helpers.js";
import { registerMixinRoutes } from "./mixins.js";
import { registerNetworkRoutes } from "./network.js";
import { registerProfileRoutes } from "./profiles.js";
import { registerServiceRoutes } from "./service.js";
import { registerSubscriptionRoutes } from "./subscriptions.js";
import { registerSystemRoutes } from "./system.js";

export function createApiRouter(services) {
  const routes = new RouteTable({ onError: requestError });
  registerSystemRoutes(routes, services);
  registerNetworkRoutes(routes, services);
  registerServiceRoutes(routes, services);
  registerProfileRoutes(routes, services);
  registerMixinRoutes(routes, services);
  registerSubscriptionRoutes(routes, services);
  registerEnhancementRoutes(routes, services);
  return routes;
}
