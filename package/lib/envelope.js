export function success(result, status = 200) {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: { ok: true, result },
  };
}

export function failure(status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: { ok: false, error },
  };
}

export function errorResponse(error) {
  if (error && error.name === "AbortError")
    return failure(499, "request_aborted", "The request was cancelled");
  return failure(502, "controller_error", errorMessage(error));
}

export function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error ?? "Unknown error");
}

export function methodNotAllowed(allowed) {
  const response = failure(405, "method_not_allowed", "Method not allowed");
  response.headers.allow = allowed.join(", ");
  return response;
}

export function parseJsonBody(body, decoder) {
  if (!body || body.byteLength === 0) return {};
  try {
    const value = JSON.parse(decoder.decode(body));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("JSON body must be an object");
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiInputError("invalid_json", message);
  }
}

export class ApiInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApiInputError";
    this.code = code;
  }
}
