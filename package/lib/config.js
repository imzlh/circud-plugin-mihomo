const SECRET_PATH = "/etc/io.cno.mihomo/controller.secret";
const FIXED_CONFIG = Object.freeze({
  controllerUrl: "http://127.0.0.1:9090",
  requestTimeoutMs: 30000,
  streamConnectTimeoutMs: 10000,
});

export class ControllerConfig {
  constructor({ fs, decoder }) {
    this.fs = fs;
    this.decoder = decoder;
    this.value = Object.freeze({ ...FIXED_CONFIG, secret: this.#readSecret() });
  }

  status() {
    return {
      controllerUrl: this.value.controllerUrl,
      secretConfigured: this.value.secret.length > 0,
    };
  }

  #readSecret() {
    if (!this.fs.exists(SECRET_PATH)) return "";
    const value = this.decoder.decode(this.fs.readFile(SECRET_PATH)).trim();
    if (value.length > 4096)
      throw new Error("Controller secret exceeds 4096 characters");
    return value;
  }
}
