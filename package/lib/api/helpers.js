import { ApiInputError, failure, parseJsonBody, success } from "../envelope.js";
import { ConflictError } from "../profiles.js";
import { RouteInputError } from "../route-table.js";
import { ApiError } from "../api-error.js";
export {
  defaultNetworkConfig,
  normalizeNetworkConfig,
} from "../network-config.js";

export const BACKGROUND_SIGNAL = Object.freeze({
  aborted: false,
  addEventListener() {},
  removeEventListener() {},
});

export function body(event, services) {
  return parseJsonBody(event.body, services.decoder);
}

export function startOperation(services, kind, input) {
  const accepted = services.operations.start(kind, () =>
    services.control.invoke(kind, input, BACKGROUND_SIGNAL),
  );
  return success(accepted, 202);
}

export function requestError(error) {
  if (error instanceof ApiError)
    return failure(error.status, error.code, error.message, error.details);
  if (error instanceof ConflictError)
    return failure(409, error.code, error.message, {
      currentRevision: error.currentRevision,
    });
  if (error instanceof ApiInputError || error instanceof RouteInputError)
    return failure(400, error.code ?? "invalid_path", error.message);
  return failure(
    400,
    "invalid_request",
    error instanceof Error ? error.message : String(error),
  );
}

export function defaultGlobalEnhancement() {
  return {
    version: 1,
    merge: { enabled: false, content: "{}\n" },
    script: {
      enabled: false,
      content: "function main(config, profileName) { return config; }\n",
    },
  };
}

