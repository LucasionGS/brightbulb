import { execFile, spawnSync } from "node:child_process";

/**
 * Tiny D-Bus helpers built on `dbus-send`, which ships with dbus itself, so no
 * npm D-Bus binding is needed for the two questions BrightBulb asks.
 */
export namespace DBus {
  function args(name: string): string[] {
    return [
      "--session", "--print-reply", "--dest=org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus.NameHasOwner", `string:${name}`,
    ];
  }

  /**
   * Whether `name` currently has an owner on the session bus.
   */
  export function nameHasOwner(name: string, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      execFile("dbus-send", args(name), { timeout: timeoutMs }, (error, stdout) => {
        resolve(!error && /boolean true/.test(stdout));
      });
    });
  }

  /**
   * Blocking variant of `nameHasOwner`, for decisions that must be made
   * before Electron's `ready` event (such as the password store switch).
   */
  export function nameHasOwnerSync(name: string, timeoutMs = 500): boolean {
    const result = spawnSync("dbus-send", args(name), { timeout: timeoutMs, encoding: "utf8" });
    return result.status === 0 && /boolean true/.test(result.stdout);
  }
}

export default DBus;
