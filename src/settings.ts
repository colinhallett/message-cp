import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A setting from the environment: `MESSAGE_CP_<name>`. An empty value is returned as set: `serve` and
 * MESSAGE_CP_AGENT refuse it, and an empty MESSAGE_CP_DB means the default path.
 */
export function setting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`MESSAGE_CP_${name}`];
}

/** `~/.message-cp/<file>`. */
export function homeFile(file: string, home: string = homedir()): string {
  return join(home, ".message-cp", file);
}
