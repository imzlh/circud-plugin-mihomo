import { errorResponse, failure, success } from "../envelope.js";
import { RESPONSE_HANDLED } from "../route-table.js";

export function registerSystemRoutes(routes, services) {
  routes.on("GET", "/status", (event) =>
    Promise.all([
      Promise.resolve().then(() =>
        services.control.invoke("status", {}, event.signal),
      ),
      services.controller.probe(event.signal).catch((error) => ({
        reachable: false,
        error: error instanceof Error ? error.message : String(error),
      })),
    ])
      .then(([status, controller]) => success({ ...status, controller }))
      .catch(errorResponse),
  );
  routes.on("GET", "/capabilities", (event) =>
    Promise.resolve()
      .then(() => services.control.invoke("capabilities", {}, event.signal))
      .then(success)
      .catch(errorResponse),
  );
  routes.on("GET", "/operations", () => success(services.operations.list()));
  routes.on("GET", "/operations/:id", (_event, { id }) => {
    const operation = services.operations.get(id);
    return operation
      ? success(operation)
      : failure(404, "operation_not_found", "Operation not found");
  });
  routes.on("GET", "/events", (event) => {
    services.sse.accept(event);
    return RESPONSE_HANDLED;
  });
}
