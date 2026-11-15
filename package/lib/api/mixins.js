import { failure, success } from "../envelope.js";
import { body } from "./helpers.js";

/** Register CRUD endpoints for reusable, ordered compiler stages. */
export function registerMixinRoutes(routes, services) {
  routes.on("GET", "/mixins", () => success(services.profiles.mixins()));
  routes.on("POST", "/mixins", (event) => {
    const mixin = services.profiles.createMixin(body(event, services));
    services.operations.emit("mixin.created", mixin);
    return success(mixin, 201);
  });
  routes.on("GET", "/mixins/:id", (_event, { id }) => {
    const mixin = services.profiles.mixin(id);
    return mixin
      ? success(mixin)
      : failure(404, "mixin_not_found", "Mixin not found");
  });
  routes.on("PUT", "/mixins/:id", (event, { id }) => {
    const mixin = services.profiles.updateMixin(id, body(event, services));
    if (mixin) services.operations.emit("mixin.updated", mixin);
    return mixin
      ? success(mixin)
      : failure(404, "mixin_not_found", "Mixin not found");
  });
  routes.on("DELETE", "/mixins/:id", (event, { id }) => {
    const removed = services.profiles.deleteMixin(
      id,
      body(event, services).expectedRevision,
    );
    if (removed) services.operations.emit("mixin.removed", { id });
    return removed
      ? success({ removed: true })
      : failure(404, "mixin_not_found", "Mixin not found");
  });
}
