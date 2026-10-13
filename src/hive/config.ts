import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { validateName } from "../agents.js";

const agentSchema = z.strictObject({
  name: z.string(),
  cli: z.string().default("claude"),
  key: z.string().min(1),
  cwd: z.string().min(1),
  model: z.string().optional(),
  allowedTools: z.array(z.string()),
  timeoutSeconds: z.number().positive(),
  rolePrompt: z.string().optional(),
});

const configSchema = z.strictObject({
  pollMs: z.number().int().min(50).default(1000),
  agents: z.array(agentSchema).min(1),
});

export type AgentConfig = z.infer<typeof agentSchema>;
export type HiveConfig = z.infer<typeof configSchema>;

/** Parses and validates a config; relative `cwd`s are resolved against `baseDir`. */
export function parseConfig(text: string, baseDir: string): HiveConfig {
  const config = configSchema.parse(JSON.parse(text));
  const seen = new Set<string>();
  for (const agent of config.agents) {
    validateName(agent.name);
    const lower = agent.name.toLowerCase();
    if (seen.has(lower)) throw new Error(`Agent '${agent.name}' appears twice in the config.`);
    seen.add(lower);
    agent.cwd = resolve(baseDir, agent.cwd);
  }
  return config;
}

export function loadConfig(path: string): HiveConfig {
  // The config holds keys, so other local accounts must not be able to read it.
  if (statSync(path).mode & 0o077) {
    console.error(`memory-cp hive: ${path} holds agent keys but is readable by others; run chmod 600 on it.`);
  }
  return parseConfig(readFileSync(path, "utf8"), resolve(path, ".."));
}
