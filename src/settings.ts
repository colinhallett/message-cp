import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A setting from the environment: `MESSAGE_CP_<name>` when it is set, else the old `MEMORY_CP_<name>`, which keeps
 * working for installs set up before the rename. A new name that is set wins even when empty, so the caller still
 * sees, and can refuse, the empty value it was given.
 */
export function setting(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[`MESSAGE_CP_${name}`] ?? env[`MEMORY_CP_${name}`];
}

/**
 * `~/.message-cp/<file>`, unless only the old `~/.memory-cp/<file>` exists: then that one, read where it is and never
 * moved or copied, so a server still running on it loses nothing.
 */
export function homeFile(file: string, home: string = homedir()): string {
  const path = join(home, ".message-cp", file);
  const old = join(home, ".memory-cp", file);
  return !existsSync(path) && existsSync(old) ? old : path;
}
