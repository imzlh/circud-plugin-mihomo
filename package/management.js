/** @typedef {import('circud').EndpointEvent} EndpointEvent */
/** @typedef {import('circud').ManagementCallEvent} ManagementCallEvent */

import { info } from "circud";
import { ControllerConfig } from "./lib/config.js";
import { ControllerClient } from "./lib/controller.js";
import { ControlClient } from "./lib/control.js";
import { ProfileCompiler } from "./lib/compiler.js";
import { OperationStore } from "./lib/operations.js";
import { Repository } from "./lib/profiles.js";
import { Router } from "./lib/router.js";
import { SseHub } from "./lib/sse.js";
import { SubscriptionService } from "./lib/services/subscriptions.js";
import { RestartScheduler } from "./lib/services/restart-scheduler.js";

const evbus = import.meta.use("evbus");
const fs = import.meta.use("fs");
const curl = import.meta.use("curl");
const processModule = import.meta.use("process");
const cryptoModule = import.meta.use("crypto");
const { Encoder, Decoder } = import.meta.use("text");
const utf8Encoder = new Encoder("utf-8");

const host = info();
if (!host) throw new Error("circud host information is unavailable");

const config = new ControllerConfig({
  fs,
  decoder: new Decoder("utf-8"),
});
const operations = new OperationStore();
const sse = new SseHub();
const profiles = new Repository({
  fs,
  path: `${host.dataDir}/profiles.json`,
  encoder: new Encoder("utf-8"),
  decoder: new Decoder("utf-8", { fatal: true }),
});
const control = new ControlClient({
  processModule,
  fs,
  encoder: new Encoder("utf-8"),
  decoder: new Decoder("utf-8"),
});
const controller = new ControllerClient({
  curlModule: curl,
  configStore: config,
  decoderFactory: () => new Decoder("utf-8"),
});
const compiler = new ProfileCompiler({
  control,
  profiles,
  config,
  sha256: async (value) => {
    const digest = new Uint8Array(
      cryptoModule.sha256(utf8Encoder.encode(value)),
    );
    return Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  },
});
const subscriptions = new SubscriptionService({
  controller,
  profiles,
  operations,
});
subscriptions.start();
const restartScheduler = new RestartScheduler({
  profiles,
  operations,
  control,
});
restartScheduler.start();
const router = new Router({
  config,
  controller,
  control,
  compiler,
  profiles,
  operations,
  subscriptions,
  restartScheduler,
  sse,
  decoder: new Decoder("utf-8", { fatal: true }),
  decoderFactory: () => new Decoder("utf-8"),
});

operations.subscribe((event) => sse.publish(event));

evbus.on(
  "circud.host",
  "endpoint",
  /** @param {EndpointEvent} event */ (event) => router.handle(event),
);

evbus.on(
  "circud.host",
  "call",
  /** @param {ManagementCallEvent} event */ (event) => {
    switch (event.target) {
      case "status.get":
        event.respondWith({
          state: "running",
          message: `Mihomo manager ready; ${operations.list().length} recent operations`,
        });
        break;
      case "lifecycle.stop":
        event.respondWith(
          Promise.resolve().then(() => {
            sse.close();
            controller.close();
            control.close();
            subscriptions.close();
            restartScheduler.close();
            profiles.close();
            return { stopped: true };
          }),
        );
        break;
    }
  },
);
