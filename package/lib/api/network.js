import { success } from "../envelope.js";
import {
  body,
  defaultNetworkConfig,
  normalizeNetworkConfig,
  startOperation,
} from "./helpers.js";

const SERVICE_ACTIONS = ["start", "reload", "restart", "stop"];
const NETWORK_ACTIONS = ["enable", "disable", "reconcile"];

export function registerNetworkRoutes(routes, services) {
  const readNetwork = () => {
    const stored = services.profiles.setting("network", defaultNetworkConfig());
    return success({
      revision: stored.revision,
      config: normalizeNetworkConfig(stored.config),
    });
  };
  const writeNetwork = (event) => {
    const input = body(event, services);
    const updated = services.profiles.setSetting(
      "network",
      normalizeNetworkConfig(input.config),
      input.expectedRevision,
      "network_revision_conflict",
    );
    services.operations.emit("network.config.updated", updated);
    return success(updated);
  };
  routes.on("GET", "/network", readNetwork);
  routes.on("PUT", "/network", writeNetwork);
  routes.on("GET", "/network/config", readNetwork);
  routes.on("PUT", "/network/config", writeNetwork);

  for (const action of SERVICE_ACTIONS)
    routes.on("POST", `/service/${action}`, (event) =>
      startOperation(services, `service.${action}`, body(event, services)),
    );
  for (const action of NETWORK_ACTIONS)
    routes.on("POST", `/network/${action}`, (event) => {
      const input = body(event, services);
      if (action !== "disable") {
        input.config = services.profiles.setting(
          "network",
          defaultNetworkConfig(),
        ).config;
        input.config = normalizeNetworkConfig(input.config);
      }
      return startOperation(services, `network.${action}`, input);
    });
  routes.on("POST", "/generation/rollback", (event) =>
    startOperation(services, "generation.rollback", body(event, services)),
  );
}
