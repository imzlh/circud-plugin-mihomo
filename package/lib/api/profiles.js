import { errorResponse, failure, success } from "../envelope.js";
import { ConflictError } from "../profiles.js";
import { BACKGROUND_SIGNAL, body } from "./helpers.js";

export function registerProfileRoutes(routes, services) {
  routes.on("GET", "/profiles", () => success(services.profiles.profiles()));
  routes.on("POST", "/profiles", (event) => {
    const profile = services.profiles.createProfile(body(event, services));
    services.operations.emit("profile.created", profile);
    return success(profile, 201);
  });
  routes.on(["POST", "PUT"], "/profiles/reorder", (event) => {
    const profiles = services.profiles.reorder(body(event, services).ids);
    services.operations.emit("profile.reordered", {
      ids: profiles.map((profile) => profile.id),
    });
    return success(profiles);
  });
  routes.on("POST", "/profiles/fetch", (event) =>
    services.controller
      .fetchSubscription(body(event, services).url, event.signal)
      .then(({ content }) => success({ content }))
      .catch(errorResponse),
  );
  routes.on("GET", "/profiles/:id/revisions", (_event, { id }) =>
    success(services.profiles.revisions(id)),
  );
  routes.on("GET", "/profiles/:id/revisions/:revision", (_event, params) =>
    revisionResponse(services, params.id, Number(params.revision)),
  );
  routes.on("POST", "/profiles/:id/revisions/:revision", (_event, params) => {
    const revision = Number(params.revision);
    if (!Number.isSafeInteger(revision) || revision < 1)
      return failure(
        400,
        "invalid_revision",
        "Revision must be a positive integer",
      );
    const profile = services.profiles.activate(params.id, revision);
    if (profile)
      services.operations.emit("profile.revision.activated", profile);
    return profile
      ? success(profile)
      : failure(
          404,
          "profile_revision_not_found",
          "Profile revision not found",
        );
  });
  routes.on("POST", "/profiles/:id/preview", (event, { id }) =>
    withCurrentProfile(services, event, id, (profile) =>
      services.subscriptions
        .prepareProfile(profile, event.signal)
        .then(({ profile: prepared, subscriptionRefresh }) =>
          services.compiler
            .compile(prepared, event.signal)
            .then((preview) => success({ ...preview, subscriptionRefresh })),
        )
        .catch(errorResponse),
    ),
  );
  routes.on("POST", "/profiles/:id/apply", (event, { id }) =>
    withCurrentProfile(services, event, id, (profile, input) => {
      return services.subscriptions
        .prepareProfile(profile, event.signal)
        .then(({ profile: prepared }) => {
          if (prepared.revision !== input.expectedRevision)
            throw new ConflictError(
              "profile_revision_conflict",
              prepared.revision,
            );
          const accepted = services.operations.start("profile.apply", () =>
            services.compiler.apply(
              prepared,
              input.options ?? {},
              BACKGROUND_SIGNAL,
            ),
          );
          return success(accepted, 202);
        });
    }),
  );
  routes.on("GET", "/profiles/:id", (_event, { id }) => {
    const profile = services.profiles.profile(id);
    return profile
      ? success(profile)
      : failure(404, "profile_not_found", "Profile not found");
  });
  routes.on("PUT", "/profiles/:id", (event, { id }) => {
    const profile = services.profiles.updateProfile(id, body(event, services));
    if (profile) services.operations.emit("profile.updated", profile);
    return profile
      ? success(profile)
      : failure(404, "profile_not_found", "Profile not found");
  });
  routes.on("DELETE", "/profiles/:id", (event, { id }) => {
    const removed = services.profiles.deleteProfile(
      id,
      body(event, services).expectedRevision,
    );
    if (removed) services.operations.emit("profile.removed", { id });
    return removed
      ? success({ removed: true })
      : failure(404, "profile_not_found", "Profile not found");
  });
}

function revisionResponse(services, id, revision) {
  if (!Number.isSafeInteger(revision) || revision < 1)
    return failure(
      400,
      "invalid_revision",
      "Revision must be a positive integer",
    );
  const profile = services.profiles.profile(id, revision);
  return profile
    ? success(profile)
    : failure(404, "profile_revision_not_found", "Profile revision not found");
}

function withCurrentProfile(services, event, id, use) {
  const input = body(event, services);
  const profile = services.profiles.profile(id);
  if (!profile) return failure(404, "profile_not_found", "Profile not found");
  if (input.expectedRevision !== profile.revision)
    throw new ConflictError("profile_revision_conflict", profile.revision);
  return use(profile, input);
}
