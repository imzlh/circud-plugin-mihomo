import { failure, success } from "../envelope.js";
import { BACKGROUND_SIGNAL, body } from "./helpers.js";

export function registerSubscriptionRoutes(routes, services) {
  routes.on("GET", "/subscriptions", () =>
    success(services.profiles.subscriptions()),
  );
  routes.on("POST", "/subscriptions", (event) => {
    const subscription = services.profiles.createSubscription(body(event, services));
    services.subscriptions.reschedule();
    services.operations.emit("subscription.created", subscription);
    return success(subscription, 201);
  });
  routes.on("POST", "/subscriptions/import", (event) => {
    const input = body(event, services);
    return services.subscriptions.import(input, event.signal).then((imported) => {
        services.operations.emit("subscription.imported", {
          subscription: imported.subscription,
          profile: {
            id: imported.profile.id,
            name: imported.profile.name,
            revision: imported.profile.revision,
          },
        });
        services.subscriptions.reschedule();
        return success(imported, 201);
      });
  });
  routes.on("POST", "/subscriptions/refresh", (event) => {
    const input = body(event, services);
    const accepted = services.operations.start("subscription.refresh-many", () =>
      services.subscriptions.refreshMany(input.ids, BACKGROUND_SIGNAL),
    );
    return success(accepted, 202);
  });
  routes.on("POST", "/subscriptions/:id/refresh", (event, { id }) => {
    return services.subscriptions.refresh(id, event.signal).then(success);
  });
  routes.on("GET", "/subscriptions/:id", (_event, { id }) => {
    const subscription = services.profiles.subscription(id);
    return subscription
      ? success(subscription)
      : failure(404, "subscription_not_found", "Subscription not found");
  });
  routes.on("PUT", "/subscriptions/:id", (event, { id }) => {
    const subscription = services.profiles.updateSubscription(
      id,
      body(event, services),
    );
    if (subscription) services.operations.emit("subscription.updated", subscription);
    if (subscription) services.subscriptions.reschedule();
    return subscription
      ? success(subscription)
      : failure(404, "subscription_not_found", "Subscription not found");
  });
  routes.on("DELETE", "/subscriptions/:id", (event, { id }) => {
    const removed = services.profiles.deleteSubscription(
      id,
      body(event, services).expectedRevision,
    );
    if (removed) services.operations.emit("subscription.removed", { id });
    if (removed) services.subscriptions.reschedule();
    return removed
      ? success({ removed: true })
      : failure(404, "subscription_not_found", "Subscription not found");
  });
}
