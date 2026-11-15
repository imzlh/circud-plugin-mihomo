import { success } from "../envelope.js";
import { normalizeRestartSchedule } from "../services/restart-scheduler.js";
import { body } from "./helpers.js";

/** Register persistent Mihomo service policy endpoints. */
export function registerServiceRoutes(routes, services) {
  routes.on("GET", "/service/schedule", () =>
    success(services.restartScheduler.schedule()),
  );
  routes.on("PUT", "/service/schedule", (event) => {
    const input = body(event, services);
    const updated = services.profiles.setSetting(
      "service.schedule",
      normalizeRestartSchedule(input.config),
      input.expectedRevision,
      "restart_schedule_revision_conflict",
    );
    services.restartScheduler.reschedule();
    services.operations.emit("service.schedule.updated", updated);
    return success(updated);
  });
}
