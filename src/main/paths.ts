import os from "node:os";
import Path from "node:path";

/**
 * XDG base directories for BrightBulb, matching v1's locations so both
 * versions share one settings file.
 */
export namespace Paths {
  const home = os.homedir();

  /**
   * `$XDG_CONFIG_HOME/brightbulb`: settings and the encrypted secrets blob.
   */
  export const config = Path.join(process.env.XDG_CONFIG_HOME || Path.join(home, ".config"), "brightbulb");
  /**
   * `$XDG_STATE_HOME/brightbulb`: where v1 kept credentials when no keyring was running.
   */
  export const state = Path.join(process.env.XDG_STATE_HOME || Path.join(home, ".local", "state"), "brightbulb");
  /**
   * `$XDG_CACHE_HOME/brightbulb`: Chromium's own session data, kept out of the config dir.
   */
  export const cache = Path.join(process.env.XDG_CACHE_HOME || Path.join(home, ".cache"), "brightbulb");

  export const settingsFile = Path.join(config, "settings.json");
  export const secretsFile = Path.join(config, "secrets.bin");
  export const v1CredentialsFile = Path.join(state, "credentials.json");
}

export default Paths;
