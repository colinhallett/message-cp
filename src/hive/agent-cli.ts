import { readFileSync } from "node:fs";

/** What a run needs from whichever agent CLI executes it. */
export interface RunSpec {
  agent: string;
  /** The agent's working directory. */
  cwd: string;
  prompt: string;
  /** Path of a mode 0600 MCP config that starts this server as the agent. */
  mcpConfigPath: string;
  model?: string;
  allowedTools: string[];
  rolePrompt?: string;
  /** The agent's previous session, if it has one. */
  resumeSessionId?: string;
}

export interface Command {
  command: string;
  args: string[];
  /** Written to the process's stdin, so message text never appears in `ps`. */
  stdin: string;
  /** Added to the process's environment, for values that must not appear in `ps`. */
  env?: Record<string, string>;
}

/** The one place that knows a CLI's flags. A second CLI is a second implementation. */
export interface AgentCli {
  build(spec: RunSpec): Command;
  /** The session id to resume next time, found in the CLI's stdout. */
  parseSessionId(stdout: string): string | undefined;
}

/** Server name in the MCP config, so its tools are `mcp__memory-cp__*`. */
export const MCP_SERVER_NAME = "memory-cp";

/**
 * Claude Code, non-interactive. It ignores settings files in this mode, so every permission comes
 * from flags. `dontAsk` refuses whatever is not allowed, and no prompt is ever shown.
 */
export const claudeCli: AgentCli = {
  build(spec) {
    const args = [
      "-p",
      "--output-format", "json",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--strict-mcp-config",
      // No user, project or local settings: a settings file in the agent's directory cannot grant tools or add hooks.
      "--setting-sources", "",
      "--mcp-config", spec.mcpConfigPath,
      "--allowedTools", [`mcp__${MCP_SERVER_NAME}`, ...spec.allowedTools].join(","),
    ];
    if (spec.model) args.push("--model", spec.model);
    if (spec.rolePrompt) args.push("--append-system-prompt", spec.rolePrompt);
    if (spec.resumeSessionId) args.push("--resume", spec.resumeSessionId);
    return { command: "claude", args, stdin: spec.prompt };
  },
  parseSessionId(stdout) {
    try {
      const result = JSON.parse(stdout) as { session_id?: unknown };
      return typeof result.session_id === "string" ? result.session_id : undefined;
    } catch {
      return undefined;
    }
  },
};

/** Claude tools that write; the only reason a Codex agent gets a writable sandbox. */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const toml = (value: unknown) => JSON.stringify(value);

/**
 * Codex, non-interactive. Codex has no per-tool allowlist, so `allowedTools` maps onto its sandbox: a
 * write tool gives `workspace-write` (no network), anything else `read-only`. Approval is `never`, so
 * a refused action fails instead of waiting for a prompt. Sandbox and approval are config overrides on
 * every run because `codex exec resume` has no flag for either; the working directory is the process's.
 * Shell commands cannot be limited per command, so `Bash(...)` entries do not widen or narrow anything.
 */
export const codexCli: AgentCli = {
  build(spec) {
    const server = JSON.parse(readFileSync(spec.mcpConfigPath, "utf8")).mcpServers[MCP_SERVER_NAME] as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    const sandbox = spec.allowedTools.some((t) => WRITE_TOOLS.has(t.replace(/\(.*$/, ""))) ? "workspace-write" : "read-only";
    const key = `mcp_servers.${MCP_SERVER_NAME}`;
    const overrides = [
      `approval_policy=${toml("never")}`,
      `sandbox_mode=${toml(sandbox)}`,
      `${key}.command=${toml(server.command)}`,
      `${key}.args=${toml(server.args)}`,
      // Names only: the values, the key among them, travel in the process environment.
      `${key}.env_vars=${toml(Object.keys(server.env))}`,
      `${key}.default_tools_approval_mode=${toml("approve")}`,
      // Commands the agent runs must not see its identity or key.
      `shell_environment_policy.exclude=${toml(["MEMORY_CP_*"])}`,
    ];
    if (spec.rolePrompt) overrides.push(`developer_instructions=${toml(spec.rolePrompt)}`);
    const args = ["exec"];
    if (spec.resumeSessionId) args.push("resume");
    args.push("--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules");
    if (!spec.resumeSessionId) args.push("-C", spec.cwd);
    if (spec.model) args.push("-m", spec.model);
    for (const o of overrides) args.push("-c", o);
    if (spec.resumeSessionId) args.push(spec.resumeSessionId);
    args.push("-");
    return { command: "codex", args, stdin: spec.prompt, env: server.env };
  },
  parseSessionId(stdout) {
    for (const line of stdout.split("\n")) {
      try {
        const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
        if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
      } catch {
        // Not a JSON event line.
      }
    }
    return undefined;
  },
};
