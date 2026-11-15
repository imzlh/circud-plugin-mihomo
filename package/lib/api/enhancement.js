import { success } from "../envelope.js";
import { body, defaultGlobalEnhancement } from "./helpers.js";

export function registerEnhancementRoutes(routes, services) {
  routes.on("GET", "/enhancement/global", () => {
    const value = services.profiles.setting(
      "enhancement.global",
      defaultGlobalEnhancement(),
    );
    return success({ revision: value.revision, enhancement: value.config });
  });
  routes.on("PUT", "/enhancement/global", (event) => {
    const input = body(event, services);
    const updated = services.profiles.setSetting(
      "enhancement.global",
      input.enhancement ?? input.config,
      input.expectedRevision,
      "enhancement_revision_conflict",
    );
    services.operations.emit("enhancement.global.updated", updated);
    return success({
      revision: updated.revision,
      enhancement: updated.config,
    });
  });
}
